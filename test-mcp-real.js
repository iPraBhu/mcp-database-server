#!/usr/bin/env node

import { spawn } from 'child_process';
import { join } from 'path';

const serverPath = join(process.cwd(), 'dist', 'index.js');
const configPath = 'C:\\QNST\\services\\.mcp-database-server.config';

console.log('Starting MCP server with config:', configPath);
const server = spawn('node', [serverPath, '--config', configPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: process.cwd()
});

let messageId = 1;

// Send initialize request
const initRequest = {
  jsonrpc: '2.0',
  id: messageId++,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-client',
      version: '1.0.0'
    }
  }
};

console.log('Sending initialize request...');
server.stdin.write(JSON.stringify(initRequest) + '\n');

// Send initialized notification
setTimeout(() => {
  const initializedNotification = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  };
  console.log('Sending initialized notification...');
  server.stdin.write(JSON.stringify(initializedNotification) + '\n');

  // Send list tools request
  setTimeout(() => {
    const listToolsRequest = {
      jsonrpc: '2.0',
      id: messageId++,
      method: 'tools/list',
      params: {}
    };
    console.log('Sending tools/list request...');
    server.stdin.write(JSON.stringify(listToolsRequest) + '\n');

    // Send list databases request
    setTimeout(() => {
      const listDatabasesRequest = {
        jsonrpc: '2.0',
        id: messageId++,
        method: 'tools/call',
        params: {
          name: 'list_databases',
          arguments: {}
        }
      };
      console.log('Sending list_databases tool call...');
      server.stdin.write(JSON.stringify(listDatabasesRequest) + '\n');
    }, 200);
  }, 100);
}, 100);

// Listen for responses
let responseCount = 0;
server.stdout.on('data', (data) => {
  const response = data.toString().trim();
  console.log('Server response:', response);
  responseCount++;

  // Exit after receiving a few responses
  if (responseCount >= 3) {
    setTimeout(() => {
      server.kill();
    }, 100);
  }
});

// Handle server exit
server.on('exit', (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code || 0);
});

// Exit after 10 seconds
setTimeout(() => {
  console.log('Timeout - killing server');
  server.kill();
}, 10000);