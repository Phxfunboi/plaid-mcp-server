import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Configuration, PlaidApi, PlaidEnvironments, Products } from 'plaid';
import dotenv from 'dotenv';
import cron from 'node-cron';

// Load environment variables
dotenv.config();

// Basic in-memory storage for user data
// In a production app, you'd use a proper database
interface UserData {
  plaidAccessTokens: Record<string, string>;
  plaidItemIds: Record<string, string>;
  accounts: Record<string, any[]>;
  transactions: Record<string, any[]>;
  transactionCursors: Record<string, string>;
  syncSchedules: Record<string, string>; // userId -> cron schedule
  refreshSettings: Record<string, {
    frequency: 'daily' | 'weekly' | 'monthly' | 'custom',
    customCron?: string,
    lastRefreshed: string
  }>;
  webhookData: Record<string, any[]>;
}

const userData: UserData = {
  plaidAccessTokens: {},
  plaidItemIds: {},
  accounts: {},
  transactions: {},
  transactionCursors: {},
  syncSchedules: {},
  refreshSettings: {},
  webhookData: {}
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

// Map to store cron jobs
const cronJobs = new Map();

// Set up all Plaid Transactions functionality for an MCP server
export function setupPlaidTransactionsServer(server: McpServer) {
  // Tool 1: Create a link token for Plaid Link with Auth and Transactions products
  server.tool(
    "create-link-token",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      redirectUri: z.string().optional().describe("The URI to redirect to after the user completes the Link flow"),
      includeBankTransfers: z.boolean().optional().describe("Include bank transfers permission"),
      includeAuth: z.boolean().default(true).describe("Include auth permission"),
      includeTransactions: z.boolean().default(true).describe("Include transactions permission"),
      historyDays: z.number().min(30).max(730).default(90).describe("Days of transaction history to request")
    },
    async ({ userId, redirectUri, includeBankTransfers = false, includeAuth = true, includeTransactions = true, historyDays = 90 }) => {
      try {
        // List of Plaid products to initialize
        const products: Products[] = [];
        
        if (includeAuth) {
          products.push('auth');
        }
        
        if (includeTransactions) {
          products.push('transactions');
        }
        
        // Prepare link token request
        const request: any = {
          user: { client_user_id: userId },
          client_name: process.env.PLAID_CLIENT_NAME || "Your App Name",
          products: products,
          country_codes: ['US'],
          language: 'en',
          webhook: process.env.PLAID_WEBHOOK_URL,
        };

        // Add transactions options if needed
        if (includeTransactions) {
          request.transactions = {
            days_requested: historyDays
          };
        }

        // Add bank transfer options if needed
        if (includeBankTransfers) {
          request.account_filters = {
            depository: {
              account_subtypes: ['checking', 'savings']
            }
          };
        }

        // Add redirect URI if provided
        if (redirectUri) {
          request.redirect_uri = redirectUri;
        }

        // Create link token
        const response = await plaidClient.linkTokenCreate(request);

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              linkToken: response.data.link_token,
              expiration: response.data.expiration
            }) 
          }]
        };
      } catch (error) {
        console.error('Error creating link token:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to create link token" 
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

        // Initialize empty cursor for this user
        userData.transactionCursors[userId] = '';

        // Set default refresh schedule
        userData.refreshSettings[userId] = {
          frequency: 'daily',
          lastRefreshed: new Date().toISOString()
        };
        
        // Schedule a daily sync at midnight by default
        scheduleTransactionSync(userId, 'daily');

        // Fetch initial accounts and transactions
        await Promise.all([
          fetchAccounts(userId, accessToken),
          syncTransactions(userId, accessToken)
        ]);

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              userId,
              itemId,
              message: "Account successfully connected and initial sync started"
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

  // Tool 3: Get initial accounts information
  server.tool(
    "get-accounts",
    { 
      userId: z.string().describe("Unique identifier for the user")
    },
    async ({ userId }) => {
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

        // Use cached accounts if available, otherwise fetch from Plaid
        let accounts = userData.accounts[userId];
        
        if (!accounts) {
          accounts = await fetchAccounts(userId, accessToken);
        }

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              accounts
            }) 
          }]
        };
      } catch (error) {
        console.error('Error fetching accounts:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to fetch accounts" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 4: Sync transactions
  server.tool(
    "sync-transactions",
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

        // If a force refresh is requested, call Plaid's refresh endpoint first
        if (forceRefresh) {
          try {
            await plaidClient.transactionsRefresh({
              access_token: accessToken
            });
            // Update last refreshed timestamp
            if (userData.refreshSettings[userId]) {
              userData.refreshSettings[userId].lastRefreshed = new Date().toISOString();
            }
            
            // Wait briefly to allow Plaid to process the refresh
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (refreshError) {
            console.error('Error refreshing transactions:', refreshError);
            // Continue anyway, as we can still try to sync with existing data
          }
        }

        // Sync transactions
        const { added, modified, removed, hasMore, cursor } = await syncTransactions(userId, accessToken);
        
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              summary: {
                added: added.length,
                modified: modified.length,
                removed: removed.length,
                hasMore,
                lastSynced: new Date().toISOString()
              }
            }) 
          }]
        };
      } catch (error) {
        console.error('Error syncing transactions:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to sync transactions" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 5: Get transactions
  server.tool(
    "get-transactions",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
      endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
      accountId: z.string().optional().describe("Filter by specific account ID"),
      count: z.number().min(1).max(500).default(100).optional().describe("Number of transactions to return"),
      offset: z.number().min(0).default(0).optional().describe("Number of transactions to skip")
    },
    async ({ userId, startDate, endDate, accountId, count = 100, offset = 0 }) => {
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

        // If specific date range not provided, default to last 30 days
        if (!startDate) {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          startDate = thirtyDaysAgo.toISOString().split('T')[0];
        }
        
        if (!endDate) {
          endDate = new Date().toISOString().split('T')[0];
        }

        // Build request options
        const options: any = {
          count,
          offset
        };

        if (accountId) {
          options.account_ids = [accountId];
        }

        // Get transactions directly from Plaid
        const response = await plaidClient.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options
        });

        // Extract relevant data
        const { transactions, accounts, total_transactions } = response.data;

        // Update cached accounts
        userData.accounts[userId] = accounts;

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              transactions,
              accounts,
              total: total_transactions,
              startDate,
              endDate,
              count,
              offset
            }) 
          }]
        };
      } catch (error) {
        console.error('Error fetching transactions:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to fetch transactions" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 6: Get recurring transactions
  server.tool(
    "get-recurring-transactions",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      accountIds: z.array(z.string()).optional().describe("List of specific account IDs to get data for")
    },
    async ({ userId, accountIds }) => {
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

        // Get recurring transactions
        const request: any = {
          access_token: accessToken
        };

        if (accountIds && accountIds.length > 0) {
          request.account_ids = accountIds;
        }

        const response = await plaidClient.transactionsRecurringGet(request);

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              inflowStreams: response.data.inflow_streams,
              outflowStreams: response.data.outflow_streams,
              updatedDatetime: response.data.updated_datetime
            }) 
          }]
        };
      } catch (error) {
        console.error('Error fetching recurring transactions:', error);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: false, 
              error: "Failed to fetch recurring transactions" 
            }) 
          }],
          isError: true
        };
      }
    }
  );

  // Tool 7: Set transaction refresh schedule
  server.tool(
    "set-refresh-schedule",
    { 
      userId: z.string().describe("Unique identifier for the user"),
      frequency: z.enum(['daily', 'weekly', 'monthly', 'custom']).describe("How often to refresh transactions data"),
      customSchedule: z.string().optional().describe("Custom cron schedule expression (only used if frequency is 'custom')")
    },
    async ({ userId, frequency, customSchedule }) => {
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

        // If using a custom schedule, validate the cron expression
        if (frequency === 'custom') {
          if (!customSchedule) {
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify({ 
                  success: false, 
                  error: "Custom schedule must be provided when frequency is 'custom'" 
                }) 
              }],
              isError: true
            };
          }
          
          // Validate cron expression
          if (!cron.validate(customSchedule)) {
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify({ 
                  success: false, 
                  error: "Invalid cron expression for custom schedule" 
                }) 
              }],
              isError: true
            };
          }
        }

        // Store refresh preferences
        userData.refreshSettings[userId] = {
          frequency,
          customCron: customSchedule,
          lastRefreshed: new Date().toISOString()
        };

        // Schedule the sync based on frequency
        scheduleTransactionSync(userId, frequency, customSchedule);
        
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              message: `Transactions will refresh ${frequency}${frequency === 'custom' ? ' with custom schedule' : ''}` 
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

  // Tool 8: Process Plaid webhook
  server.tool(
    "process-webhook",
    { 
      webhookBody: z.any().describe("The raw webhook payload from Plaid")
    },
    async ({ webhookBody }) => {
      try {
        // Extract webhook details
        const { webhook_type, webhook_code, item_id } = webhookBody;
        
        // Find the user associated with this item ID
        let affectedUserId: string | null = null;
        for (const [userId, storedItemId] of Object.entries(userData.plaidItemIds)) {
          if (storedItemId === item_id) {
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
          webhook_type,
          webhook_code,
          webhookBody
        });

        // Handle specific webhook codes
        if (webhook_type === 'TRANSACTIONS') {
          const accessToken = userData.plaidAccessTokens[affectedUserId];
          
          switch (webhook_code) {
            case 'SYNC_UPDATES_AVAILABLE':
              // New transaction updates are available, sync them
              await syncTransactions(affectedUserId, accessToken);
              break;
              
            case 'INITIAL_UPDATE':
            case 'HISTORICAL_UPDATE':
            case 'DEFAULT_UPDATE':
              // For backward compatibility, these are older webhooks
              // that can also indicate new transactions
              await syncTransactions(affectedUserId, accessToken);
              break;
          }
        }

        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              success: true, 
              message: `Processed ${webhook_type}/${webhook_code} webhook for user ${affectedUserId}`,
              userId: affectedUserId,
              webhookType: webhook_type,
              webhookCode: webhook_code
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

  // Resource: Get stored transactions for a user
  server.resource(
    "transactions",
    "transactions://{userId}",
    async (uri, params) => {
      const { userId } = params;
      
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

      // Return the cached transactions if available
      if (!userData.transactions[userId]) {
        // If no transactions are available yet, try to sync
        try {
          const accessToken = userData.plaidAccessTokens[userId];
          await syncTransactions(userId, accessToken);
        } catch (error) {
          console.error('Error syncing transactions from resource:', error);
        }
      }
      
      const transactions = userData.transactions[userId] || [];
      
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ 
            success: true, 
            transactions,
            count: transactions.length,
            lastRefreshed: userData.refreshSettings[userId]?.lastRefreshed || null,
            refreshSchedule: userData.refreshSettings[userId]?.frequency || 'daily'
          })
        }]
      };
    }
  );

  // Resource: Get refresh settings for a user
  server.resource(
    "refresh-settings",
    "refresh-settings://{userId}",
    async (uri, params) => {
      const { userId } = params;
      
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

      // Return the refresh settings
      const settings = userData.refreshSettings[userId] || {
        frequency: 'daily',
        lastRefreshed: null
      };
      
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ 
            success: true, 
            settings
          })
        }]
      };
    }
  );

  // Resource: Get webhook events for a user
  server.resource(
    "webhook-events",
    "webhook-events://{userId}",
    async (uri, params) => {
      const { userId } = params;
      
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

      // Return the webhook events
      const webhookEvents = userData.webhookData[userId] || [];
      
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ 
            success: true, 
            webhookEvents
          })
        }]
      };
    }
  );

  return server;
}

// Helper function to fetch accounts
async function fetchAccounts(userId: string, accessToken: string): Promise<any[]> {
  try {
    const response = await plaidClient.accountsGet({
      access_token: accessToken
    });
    
    const accounts = response.data.accounts;
    userData.accounts[userId] = accounts;
    
    return accounts;
  } catch (error) {
    console.error('Error fetching accounts:', error);
    throw error;
  }
}

// Helper function to sync transactions
async function syncTransactions(userId: string, accessToken: string, keepSyncing = true): Promise<{
  added: any[],
  modified: any[],
  removed: any[],
  hasMore: boolean,
  cursor: string
}> {
  // Initialize arrays to store all transactions
  let allAdded: any[] = [];
  let allModified: any[] = [];
  let allRemoved: any[] = [];
  let hasMore = false;
  let cursor = userData.transactionCursors[userId] || '';
  
  try {
    // Keep syncing as long as there are more transactions
    do {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor
      });
      
      // Extract data
      const { added, modified, removed, next_cursor, has_more } = response.data;
      
      // Add to our arrays
      allAdded = [...allAdded, ...added];
      allModified = [...allModified, ...modified];
      allRemoved = [...allRemoved, ...removed];
      
      // Update cursor
      cursor = next_cursor;
      userData.transactionCursors[userId] = cursor;
      
      // Check if there are more
      hasMore = has_more;
    } while (hasMore && keepSyncing);
    
    // Update our cached transactions
    // For a real implementation, you would apply these changes to a database
    if (!userData.transactions[userId]) {
      userData.transactions[userId] = [];
    }
    
    // Remove transactions that were removed
    if (allRemoved.length > 0) {
      const removedIds = allRemoved.map(t => t.transaction_id);
      userData.transactions[userId] = userData.transactions[userId].filter(
        t => !removedIds.includes(t.transaction_id)
      );
    }
    
    // Update modified transactions
    if (allModified.length > 0) {
      for (const modifiedTx of allModified) {
        const index = userData.transactions[userId].findIndex(
          t => t.transaction_id === modifiedTx.transaction_id
        );
        
        if (index !== -1) {
          userData.transactions[userId][index] = modifiedTx;
        } else {
          // If not found, just add it
          userData.transactions[userId].push(modifiedTx);
        }
      }
    }
    
    // Add new transactions
    if (allAdded.length > 0) {
      userData.transactions[userId] = [...userData.transactions[userId], ...allAdded];
    }
    
    // Update last refreshed timestamp
    if (userData.refreshSettings[userId]) {
      userData.refreshSettings[userId].lastRefreshed = new Date().toISOString();
    }

    return {
      added: allAdded,
      modified: allModified,
      removed: allRemoved,
      hasMore,
      cursor
    };
  } catch (error) {
    console.error('Error syncing transactions:', error);
    throw error;
  }
}

// Helper function to schedule transaction syncs
function scheduleTransactionSync(userId: string, frequency: string, customCron?: string): void {
  // Cancel any existing job for this user
  const existingJob = cronJobs.get(userId);
  if (existingJob) {
    existingJob.stop();
  }
  
  let cronSchedule: string;
  
  // Define cron schedules based on frequency
  switch (frequency) {
    case 'daily':
      // Run at midnight every day
      cronSchedule = '0 0 * * *';
      break;
    case 'weekly':
      // Run at midnight every Sunday
      cronSchedule = '0 0 * * 0';
      break;
    case 'monthly':
      // Run at midnight on the 1st of every month
      cronSchedule = '0 0 1 * *';
      break;
    case 'custom':
      // Use custom schedule if provided, otherwise default to daily
      cronSchedule = customCron || '0 0 * * *';
      break;
    default:
      // Default to daily
      cronSchedule = '0 0 * * *';
  }
  
  // Create and store the new job
  const job = cron.schedule(cronSchedule, async () => {
    try {
      const accessToken = userData.plaidAccessTokens[userId];
      if (accessToken) {
        // First try to refresh from Plaid
        try {
          await plaidClient.transactionsRefresh({
            access_token: accessToken
          });
          // Wait briefly for Plaid to process
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (refreshError) {
          console.error(`Error refreshing transactions for user ${userId}:`, refreshError);
          // Continue anyway, as we can still try to sync with existing data
        }
        
        // Then sync transactions
        await syncTransactions(userId, accessToken);
        console.log(`Scheduled transaction sync completed for user ${userId} at ${new Date().toISOString()}`);
      }
    } catch (error) {
      console.error(`Scheduled transaction sync failed for user ${userId}:`, error);
    }
  });
  
  // Store the job
  cronJobs.set(userId, job);
  console.log(`Scheduled ${frequency} transaction sync for user ${userId}`);
}