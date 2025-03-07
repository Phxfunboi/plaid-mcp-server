// HTTP/SSE server implementation for browser clients

import express from 'express';
import cors from 'cors';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import dotenv from 'dotenv';

// Import the Plaid setup function
import { setupPlaidTransactionsServer } from './plaidTransactionsServer.js';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();

// Configure CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS ? 
  process.env.ALLOWED_ORIGINS.split(',') : 
  ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Connection-Id']
}));

app.use(express.json());

// Create MCP server
const server = new McpServer({
  name: "plaid-finance-server",
  version: "1.0.0"
});

// Set up all Plaid functionality
setupPlaidTransactionsServer(server);

// Track active SSE connections
const connections = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Handle SSE endpoint
app.get('/sse', async (req, res) => {
  console.log("New SSE connection request");
  
  // Generate a unique connection ID
  const connectionId = Date.now().toString();
  res.setHeader('Connection-Id', connectionId);
  
  const transport = new SSEServerTransport("/message", res);
  
  // Store the transport
  connections.set(connectionId, transport);
  
  try {
    await server.connect(transport);
    console.log(`SSE Transport connected with ID: ${connectionId}`);
    
    // Clean up when the connection closes
    res.on('close', () => {
      console.log(`SSE connection ${connectionId} closed`);
      connections.delete(connectionId);
    });
  } catch (error) {
    console.error("Error connecting SSE transport:", error);
    connections.delete(connectionId);
    res.status(500).end();
  }
});

// Handle message endpoint for client -> server communication
app.post('/message', async (req, res) => {
  try {
    const connectionId = req.query.connection as string;
    if (!connectionId) {
      return res.status(400).json({ error: "Missing connection ID" });
    }
    
    // Find the transport for this connection
    const transport = connections.get(connectionId);
    
    if (!transport) {
      return res.status(404).json({ error: "Connection not found" });
    }
    
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error handling message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add a special endpoint for Plaid webhooks
app.post('/webhook/plaid', async (req, res) => {
  try {
    console.log("Received Plaid webhook:", req.body);
    
    // Find any active connection to forward the webhook to
    const firstConnectionId = connections.keys().next().value;
    if (firstConnectionId) {
      const transport = connections.get(firstConnectionId);
      
      // In a production setup, you would queue this and process it properly
      console.log("Webhook received, will be processed when a client connects");
    }
    
    // Always acknowledge receipt of the webhook, even if no clients are connected
    res.status(200).send('Webhook received');
  } catch (error) {
    console.error("Error processing Plaid webhook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start the Express server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`SSE endpoint available at http://localhost:${PORT}/sse`);
  console.log(`Plaid webhook endpoint available at http://localhost:${PORT}/webhook/plaid`);
});