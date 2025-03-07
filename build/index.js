// Main entry point for stdio transport
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import { setupPlaidTransactionsServer } from './plaidTransactionsServer.js';
// Load environment variables
dotenv.config();
// Create MCP server
const server = new McpServer({
    name: "plaid-finance-server",
    version: "1.0.0"
});
// Set up all Plaid Auth functionality
// Note: We only need to set up the Transactions functionality since it includes
// all the Auth functionality plus Transactions-specific features
setupPlaidTransactionsServer(server);
// Start the server with stdio transport (for Claude Desktop, etc.)
async function main() {
    console.error("Starting Plaid Finance MCP Server with stdio transport...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
