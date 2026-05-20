import { z } from 'zod';
import { env } from '../../../config/env.js';
import { SwiggyMcpService } from '../../commerce/swiggy-mcp-service.js';
import type { AgentToolDefinition } from './legacy-tools.js';

const swiggy = new SwiggyMcpService();

const selectedAddressSchema = z.object({
  addressId: z.string().min(1),
  label: z.string().optional(),
  displayText: z.string().optional()
});

const callSchema = z.object({
  server: z.enum(['food', 'im', 'dineout']),
  toolName: z.string().min(1),
  toolArguments: z.record(z.unknown()).default({}),
  userConfirmed: z.boolean().optional()
});

export const createSwiggyTools = (): AgentToolDefinition[] => {
  if (!env.SWIGGY_MCP_ENABLED) return [];

  return [
    {
      name: 'swiggy_auth_status',
      description:
        'Check whether the current Mitr user has connected Swiggy. Call before any Swiggy Food or Instamart action. If not connected, tell the user to connect Swiggy in the Mitr app.',
      parameters: z.object({}),
      timeoutMs: 2500,
      execute: async (_input, context) => swiggy.status(context.userId)
    },
    {
      name: 'swiggy_get_addresses',
      description:
        'Get saved Swiggy delivery addresses for Food and Instamart. Stop after this and let the user choose the delivery address before searching or changing carts.',
      parameters: z.object({}),
      timeoutMs: 15_000,
      execute: async (_input, context) => swiggy.getAddresses(context.userId)
    },
    {
      name: 'swiggy_select_delivery_address',
      description:
        'Remember the Swiggy addressId selected by the user for this Mitr user. Use only after swiggy_get_addresses returns addresses and the user chooses one by voice.',
      parameters: selectedAddressSchema,
      timeoutMs: 2500,
      execute: async (input, context) =>
        swiggy.selectDeliveryAddress({
          userId: context.userId,
          addressId: input.addressId,
          label: input.label,
          displayText: input.displayText
        })
    },
    {
      name: 'swiggy_mcp_call',
      description:
        'Call an allowlisted Swiggy MCP tool for Food, Instamart, or Dineout. Always resolve and select an address first for Food/Instamart search. For place_food_order, checkout, book_table, or delete_address, call only after the user explicitly confirms the exact action, amount, address, and payment method; set userConfirmed=true.',
      parameters: callSchema,
      timeoutMs: 20_000,
      execute: async (input, context) =>
        swiggy.callTool({
          userId: context.userId,
          server: input.server,
          toolName: input.toolName,
          toolArguments: input.toolArguments,
          userConfirmed: input.userConfirmed
        })
    }
  ];
};
