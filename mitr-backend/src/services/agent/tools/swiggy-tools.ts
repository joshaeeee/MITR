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
        'Check whether Swiggy is connected for this user. Call this silently before any Swiggy Food, Instamart, Dineout, cart, checkout, address, or order tracking action. If connected=false, briefly tell the user Swiggy must be connected in the Mitr app and do not ask for OTPs, passwords, or tokens by voice. If connected=true but selectedAddress is missing for Food/Instamart, call swiggy_get_addresses next without speaking.',
      parameters: z.object({}),
      timeoutMs: 2500,
      execute: async (_input, context) => swiggy.status(context.userId)
    },
    {
      name: 'swiggy_get_addresses',
      description:
        'Get saved Swiggy delivery addresses for Food and Instamart. Call after swiggy_auth_status when no selected delivery address is available, before search/cart/checkout, or when the user changes delivery location. Present at most three voice-safe labels or short summaries and ask the user to choose one. If there are no usable addresses, tell the user to add or select an address in Swiggy or the Mitr app.',
      parameters: z.object({}),
      timeoutMs: 15_000,
      execute: async (_input, context) => swiggy.getAddresses(context.userId)
    },
    {
      name: 'swiggy_select_delivery_address',
      description:
        'Remember the Swiggy delivery address selected by the user. Use only after swiggy_get_addresses returns saved addresses and the user clearly chooses one by label, ordinal, or short description. Pass the exact addressId returned by swiggy_get_addresses; never invent or read the raw ID aloud. After this succeeds, continue the original Food/Instamart ordering request without asking for final order confirmation yet.',
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
        'Call an allowlisted Swiggy MCP tool for Food, Instamart, or Dineout after swiggy_auth_status confirms Swiggy is connected. Choose server=food for restaurants/meals/snacks, server=im for groceries/essentials/Instamart, and server=dineout for table bookings. For Food/Instamart, a delivery address must be selected before search, cart, or checkout. Offer at most three voice-friendly options from results and never read raw restaurantId, spinId, cart IDs, tokens, or internal codes aloud. For place_food_order, checkout, book_table, or delete_address, call only after the user explicitly confirms the exact action, total amount, address, and payment method if applicable; set userConfirmed=true only after that confirmation. If a final paid action fails or times out, check the relevant order/status tool before retrying.',
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
