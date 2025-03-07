import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import dotenv from 'dotenv';
import { 
  Configuration, 
  PlaidApi, 
  Products, 
  CountryCode, 
  LinkTokenCreateRequest,
  PlaidEnvironments,
  ItemPublicTokenExchangeRequest,
  AuthGetRequest
} from 'plaid';

// Load environment variables
dotenv.config();

// Basic in-memory storage for user data
// In a production app, you'd use a proper database
interface UserData {
  plaidAccessTokens: Record<string, string>;
  plaidItemIds: Record<string, string>;
  accounts: Record<string, any[]>;
  authData: Record<string, any>;
  webhookData: Record<string, any[]>;
  refreshSchedules: Record<string, string>; // accountId -> frequency
}

const userData: UserData = {
  plaidAccessTokens: {},
  plaidItemIds: {},
  accounts: {},
  authData: {},
  webhookData: {},
  refreshSchedules: {},
};

// Initialize Plaid client
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID as string,
      'PLAID-SECRET': process.env.PLAID_SECRET as string,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// Set up all Plaid Auth functionality for an MCP server
export function setupPlaidAuthServer(server: McpServer) {
  // Tool 1: Create a link token for Plaid Link with Auth product
  server.tool(
    "create-auth-link-token",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      redirectUri: z.string().optional().describe("The URI to redirect to after the user completes the Link flow")
    },
    async ({ userId, redirectUri }) => {
      try {
        // List of Plaid products to initialize
        const products: Products[] = [Products.Auth];
        
        // Prepare link token request
        const request: LinkTokenCreateRequest = {
          user: { client_user_id: userId },
          client_name: 'MCP Plaid App',
          products: products,
          country_codes: [CountryCode.Us],
          language: 'en',
          webhook: process.env.WEBHOOK_URL
        };

        // Add redirect URI if provided
        if (redirectUri) {
          Object.assign(request, { redirect_uri: redirectUri });
        }

        // Create link token
        const response = await plaidClient.linkTokenCreate(request);

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              linkToken: response.data.link_token 
            }) 
          }]
        };
      } catch (error) {
        console.error('Error creating auth link token:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to create auth link token" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 2: Exchange public token for access token
  server.tool(
    "exchange-public-token",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      publicToken: z.string().describe("Public token from Plaid Link")
    },
    async ({ userId, publicToken }) => {
      try {
        const response = await plaidClient.itemPublicTokenExchange({
          public_token: publicToken
        });

        // Store the access token and item ID for this user
        const accessToken = response.data.access_token;
        const itemId = response.data.item_id;
        
        userData.plaidAccessTokens[userId] = accessToken;
        userData.plaidItemIds[userId] = itemId;

        // Get account information right away
        await fetchAndStoreAuthData(userId, accessToken);

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              userId: userId,
              itemId: itemId
            }) 
          }]
        };
      } catch (error) {
        console.error('Error exchanging token:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to exchange public token" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 3: Get Auth data for a user
  server.tool(
    "get-auth-data",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      forceRefresh: z.boolean().optional().describe("Whether to force a refresh of the data from Plaid")
    },
    async ({ userId, forceRefresh = false }) => {
      try {
        const accessToken = userData.plaidAccessTokens[userId];
        
        if (!accessToken) {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                success: false, 
                error: "User not connected to Plaid" 
              }) 
            }],
            isError: true
          };
        }

        // If data is not cached or a refresh is requested, fetch from Plaid
        if (forceRefresh || !userData.authData[userId]) {
          await fetchAndStoreAuthData(userId, accessToken);
        }

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              authData: userData.authData[userId]
            }) 
          }]
        };
      } catch (error) {
        console.error('Error fetching auth data:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to fetch auth data" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 4: Set up transaction update frequency
  server.tool(
    "set-update-frequency",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      frequency: z.enum(['daily', 'weekly', 'monthly']).describe("How often to refresh account data")
    },
    async ({ userId, frequency }) => {
      try {
        if (!userData.plaidAccessTokens[userId]) {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                success: false, 
                error: "User not connected to Plaid" 
              }) 
            }],
            isError: true
          };
        }

        // Store the refresh schedule
        userData.refreshSchedules[userId] = frequency;
        
        // In a real implementation, you would set up a recurring job
        // based on the frequency (e.g., using a scheduler like node-cron)
        
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              message: `Account data will refresh ${frequency}` 
            }) 
          }]
        };
      } catch (error) {
        console.error('Error setting refresh schedule:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to set refresh schedule" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 5: Process webhook events
  server.tool(
    "process-webhook",
    { 
      webhookBody: z.any().describe("The raw webhook payload from Plaid")
    },
    async ({ webhookBody }) => {
      try {
        // Extract the webhook code and relevant IDs
        const webhookCode = webhookBody.webhook_code;
        const itemId = webhookBody.item_id;
        
        // Find the user associated with this item ID
        let affectedUserId: string | null = null;
        for (const [userId, storedItemId] of Object.entries(userData.plaidItemIds)) {
          if (storedItemId === itemId) {
            affectedUserId = userId;
            break;
          }
        }

        if (!affectedUserId) {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                success: false, 
                error: "Item ID not found for any user" 
              }) 
            }],
            isError: true
          };
        }

        // Store the webhook event
        if (!userData.webhookData[affectedUserId]) {
          userData.webhookData[affectedUserId] = [];
        }
        userData.webhookData[affectedUserId].push({
          timestamp: new Date().toISOString(),
          webhookCode,
          webhookBody
        });

        // Handle specific webhook codes
        let message = `Processed webhook: ${webhookCode}`;
        
        if (webhookCode === 'DEFAULT_UPDATE') {
          // Item has account(s) with updated Auth data
          const accessToken = userData.plaidAccessTokens[affectedUserId];
          await fetchAndStoreAuthData(affectedUserId, accessToken);
          message = 'Auth data updated due to DEFAULT_UPDATE webhook';
        } else if (webhookCode === 'AUTOMATICALLY_VERIFIED') {
          // Item has been verified
          message = 'Account automatically verified';
        } else if (webhookCode === 'VERIFICATION_EXPIRED') {
          // Item verification has failed
          message = 'Account verification expired';
        } else if (webhookCode === 'BANK_TRANSFERS_EVENTS_UPDATE') {
          // New micro-deposit verification events available
          message = 'New micro-deposit verification events available';
        }

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              message,
              userId: affectedUserId,
              webhookCode
            }) 
          }]
        };
      } catch (error) {
        console.error('Error processing webhook:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to process webhook" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 6: Get user's bank transfer events
  server.tool(
    "get-bank-transfer-events",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      startDate: z.string().describe("Start date in ISO format (YYYY-MM-DDTHH:MM:SSZ)"),
      endDate: z.string().describe("End date in ISO format (YYYY-MM-DDTHH:MM:SSZ)"),
      count: z.number().min(1).max(25).default(25).optional().describe("Number of events to return (max 25)"),
      offset: z.number().min(0).default(0).optional().describe("Pagination offset")
    },
    async ({ userId, startDate, endDate, count = 25, offset = 0 }) => {
      try {
        const accessToken = userData.plaidAccessTokens[userId];
        
        if (!accessToken) {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                success: false, 
                error: "User not connected to Plaid" 
              }) 
            }],
            isError: true
          };
        }

        // Get associated accounts for this user
        if (!userData.authData[userId] || !userData.authData[userId].accounts) {
          await fetchAndStoreAuthData(userId, accessToken);
        }
        
        const accountId = userData.authData[userId]?.accounts?.[0]?.account_id;
        
        if (!accountId) {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                success: false, 
                error: "No accounts found for user" 
              }) 
            }],
            isError: true
          };
        }

        // Get transfer events
        const eventsResponse = await plaidClient.bankTransferEventList({
          start_date: startDate,
          end_date: endDate,
          account_id: accountId,
          count: count,
          offset: offset
        });

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              events: eventsResponse.data.bank_transfer_events
            }) 
          }]
        };
      } catch (error) {
        console.error('Error fetching bank transfer events:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to fetch bank transfer events" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Resource: Get stored Auth data for a user
  server.resource(
    "webhook-events",
    "webhook-events://{userId}",
    async (uri, extra) => {
      // Extract userId from the URL pathname
      const urlPathParts = uri.pathname.split('/');
      const userId = urlPathParts[urlPathParts.length - 1];
      
      // Now use userId safely
      if (!userData.plaidAccessTokens[userId]) {
        return {
          contents: [{
            uri: uri.href,
            text: JSON.stringify({ 
              success: false, 
              error: "User not connected to Plaid" 
            })
          }]
        };
      }

      // Return the stored auth data
      const authData = userData.authData[userId] || {};
      
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ 
            success: true, 
            authData: authData,
            refreshSchedule: userData.refreshSchedules[userId] || 'not set'
          })
        }]
      };
    }
  );

  // Resource: Get webhook events for a user
  server.resource(
    "webhook-events",
    "webhook-events://{userId}",
    async (uri, extra) => {
      // Extract userId from the URL pathname
      const urlPathParts = uri.pathname.split('/');
      const userId = urlPathParts[urlPathParts.length - 1];
      
      // Now use userId safely
      if (!userData.plaidAccessTokens[userId]) {
        return {
          contents: [{
            uri: uri.href,
            text: JSON.stringify({ 
              success: false, 
              error: "User not connected to Plaid" 
            })
          }]
        };
      }

      // Return the stored webhook events
      const webhookEvents = userData.webhookData[userId] || [];
      
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ 
            success: true, 
            webhookEvents: webhookEvents
          })
        }]
      };
    }
  );

  // Prompt: Help setting up a bank account connection
  server.prompt(
    "connect-bank-account",
    { 
      userId: z.string().describe("Unique identifier for the user")
    },
    ({ userId }) => {
      const prompt = `Help me connect a bank account for user ${userId} using Plaid. 
      
First, create a link token using the create-auth-link-token tool, then guide me through the process of integrating this with a frontend application that uses Plaid Link.`;
      
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: prompt
          }
        }]
      };
    }
  );

  return server;
}

// Helper function to fetch and store Auth data
async function fetchAndStoreAuthData(userId: string, accessToken: string) {
  // Fetch auth data from Plaid
  const authResponse = await plaidClient.authGet({
    access_token: accessToken
  });
  
  // Store the auth data
  userData.authData[userId] = authResponse.data;
  userData.accounts[userId] = authResponse.data.accounts;
  
  return authResponse.data;
}