/* A tiny MCP server over stdio, used only by dev/mcp-check.js. It offers one
   tool that declares itself read only and one that does not, which is the
   distinction the permission gate turns on. */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'mock', version: '0.0.1' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'read_note',
    description: 'Read a note by title.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'send_mail',
    description: 'Send an email.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, body: { type: 'string' } },
      required: ['to']
    }
    // no annotations at all: the client must assume this one changes something
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'read_note') {
    return { content: [{ type: 'text', text: 'Note "' + args.title + '": buy milk.' }] };
  }
  if (name === 'send_mail') {
    return { content: [{ type: 'text', text: 'Sent to ' + args.to + '.' }] };
  }
  return { content: [{ type: 'text', text: 'No such tool.' }], isError: true };
});

await server.connect(new StdioServerTransport());
