import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { swiggyConnections, swiggyDeliveryPreferences, swiggyOAuthStates } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

type SwiggyServer = 'food' | 'im' | 'dineout';

const SERVER_PATH: Record<SwiggyServer, string> = {
  food: '/food',
  im: '/im',
  dineout: '/dineout'
};

const ALLOWED_TOOLS: Record<SwiggyServer, Set<string>> = {
  food: new Set([
    'get_addresses',
    'search_restaurants',
    'get_restaurant_menu',
    'search_menu',
    'update_food_cart',
    'get_food_cart',
    'flush_food_cart',
    'fetch_food_coupons',
    'apply_food_coupon',
    'place_food_order',
    'get_food_orders',
    'get_food_order_details',
    'track_food_order',
    'report_error'
  ]),
  im: new Set([
    'get_addresses',
    'create_address',
    'delete_address',
    'search_products',
    'your_go_to_items',
    'update_cart',
    'get_cart',
    'clear_cart',
    'checkout',
    'get_orders',
    'get_order_details',
    'track_order',
    'report_error'
  ]),
  dineout: new Set([
    'get_saved_locations',
    'search_restaurants_dineout',
    'get_restaurant_details',
    'get_available_slots',
    'create_cart',
    'book_table',
    'get_booking_status',
    'report_error'
  ])
};

const CONFIRMATION_REQUIRED = new Set(['place_food_order', 'checkout', 'book_table', 'delete_address']);

const stateHash = (state: string): string => createHash('sha256').update(state).digest('hex');

const getKey = (): Buffer => {
  if (!env.SWIGGY_TOKEN_ENCRYPTION_KEY_B64) throw new Error('Swiggy token encryption is not configured');
  return Buffer.from(env.SWIGGY_TOKEN_ENCRYPTION_KEY_B64, 'base64');
};

const encryptToken = (token: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
};

const decryptToken = (ciphertext: string): string => {
  const [iv, tag, encrypted] = ciphertext.split('.');
  if (!iv || !tag || !encrypted) throw new Error('Invalid Swiggy token ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
};

const codeChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

const assertEnabled = (): void => {
  if (!env.SWIGGY_MCP_ENABLED) throw new Error('Swiggy MCP is not enabled');
};

const asServer = (server: string): SwiggyServer => {
  if (server === 'food' || server === 'im' || server === 'dineout') return server;
  throw new Error(`Unsupported Swiggy MCP server: ${server}`);
};

const isStubMode = (): boolean => env.SWIGGY_MCP_MODE === 'stub';

const localApiBaseUrl = (): string => env.API_PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`;

const upsertStubConnection = async (userId: string): Promise<{ userId: string; expiresAt: string }> => {
  const now = new Date();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db
    .insert(swiggyConnections)
    .values({
      userId,
      accessTokenCiphertext: `stub-token:${userId}`,
      scope: 'mcp:tools',
      tokenType: 'Stub',
      expiresAt,
      status: 'active',
      lastAuthorizedAt: now,
      revokedAt: null,
      metadataJson: { mode: 'stub' },
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: swiggyConnections.userId,
      set: {
        accessTokenCiphertext: `stub-token:${userId}`,
        scope: 'mcp:tools',
        tokenType: 'Stub',
        expiresAt,
        status: 'active',
        lastAuthorizedAt: now,
        revokedAt: null,
        metadataJson: { mode: 'stub' },
        updatedAt: now
      }
    });
  return { userId, expiresAt: expiresAt.toISOString() };
};

const stubAddresses = [
  {
    addressId: 'stub-home',
    label: 'Home',
    displayText: 'Home, Koramangala 5th Block, Bengaluru',
    city: 'Bengaluru'
  },
  {
    addressId: 'stub-work',
    label: 'Work',
    displayText: 'Work, Indiranagar, Bengaluru',
    city: 'Bengaluru'
  }
];

const stubToolResult = (server: SwiggyServer, toolName: string, toolArguments: Record<string, unknown>): unknown => {
  if (toolName === 'get_addresses') {
    return { jsonrpc: '2.0', result: { status: 'ready', addresses: stubAddresses } };
  }

  if (server === 'im' && toolName === 'search_products') {
    const query = typeof toolArguments.query === 'string' ? toolArguments.query : 'milk';
    return {
      jsonrpc: '2.0',
      result: {
        status: 'ready',
        query,
        items: [
          { itemId: 'stub-milk-1', name: 'Amul Taaza Toned Milk', quantity: '1 L', price: 72, inStock: true },
          { itemId: 'stub-milk-2', name: 'Nandini Goodlife Milk', quantity: '1 L', price: 70, inStock: true },
          { itemId: 'stub-bread-1', name: 'Britannia Whole Wheat Bread', quantity: '400 g', price: 55, inStock: true }
        ]
      }
    };
  }

  if (server === 'im' && (toolName === 'update_cart' || toolName === 'get_cart')) {
    return {
      jsonrpc: '2.0',
      result: {
        status: 'ready',
        cartId: 'stub-im-cart',
        items: [{ itemId: 'stub-milk-1', name: 'Amul Taaza Toned Milk', quantity: 1, unitPrice: 72 }],
        total: 72,
        currency: 'INR'
      }
    };
  }

  if (server === 'im' && toolName === 'clear_cart') {
    return { jsonrpc: '2.0', result: { status: 'ready', cartId: 'stub-im-cart', items: [], total: 0, currency: 'INR' } };
  }

  if (server === 'food' && toolName === 'search_restaurants') {
    const query = typeof toolArguments.query === 'string' ? toolArguments.query : 'idli';
    return {
      jsonrpc: '2.0',
      result: {
        status: 'ready',
        query,
        restaurants: [
          { restaurantId: 'stub-darshini', name: 'Mitr Darshini', cuisine: 'South Indian', rating: 4.4, etaMinutes: 25 },
          { restaurantId: 'stub-cafe', name: 'Neighbourhood Cafe', cuisine: 'Snacks', rating: 4.2, etaMinutes: 30 }
        ]
      }
    };
  }

  if (server === 'food' && toolName === 'get_food_cart') {
    return { jsonrpc: '2.0', result: { status: 'ready', cartId: 'stub-food-cart', items: [], total: 0, currency: 'INR' } };
  }

  if (server === 'dineout' && toolName === 'get_saved_locations') {
    return { jsonrpc: '2.0', result: { status: 'ready', locations: [{ locationId: 'stub-blr', name: 'Bengaluru' }] } };
  }

  return {
    jsonrpc: '2.0',
    result: {
      status: 'ready',
      mode: 'stub',
      server,
      toolName,
      toolArguments
    }
  };
};

export class SwiggyMcpService {
  async startAuthorization(userId: string): Promise<{ authorizeUrl: string; expiresAt: string }> {
    assertEnabled();
    if (!isStubMode() && (!env.SWIGGY_CLIENT_ID || !env.SWIGGY_REDIRECT_URI)) throw new Error('Swiggy OAuth is not configured');

    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env.SWIGGY_OAUTH_STATE_TTL_SEC * 1000);

    await db.insert(swiggyOAuthStates).values({
      userId,
      stateHash: stateHash(state),
      codeVerifier: verifier,
      redirectUri: env.SWIGGY_REDIRECT_URI ?? new URL('/auth/swiggy/callback', localApiBaseUrl()).toString(),
      expiresAt
    });

    if (isStubMode()) {
      const url = new URL('/auth/swiggy/dev-authorize', localApiBaseUrl());
      url.searchParams.set('state', state);
      return { authorizeUrl: url.toString(), expiresAt: expiresAt.toISOString() };
    }

    const url = new URL('/auth/authorize', env.SWIGGY_MCP_BASE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', env.SWIGGY_CLIENT_ID!);
    url.searchParams.set('redirect_uri', env.SWIGGY_REDIRECT_URI!);
    url.searchParams.set('code_challenge', codeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'mcp:tools');

    return { authorizeUrl: url.toString(), expiresAt: expiresAt.toISOString() };
  }

  async completeAuthorization(input: { code: string; state: string }): Promise<{ userId: string; expiresAt: string }> {
    assertEnabled();
    if (!env.SWIGGY_CLIENT_ID) throw new Error('Swiggy OAuth is not configured');

    const [stateRow] = await db
      .select()
      .from(swiggyOAuthStates)
      .where(and(eq(swiggyOAuthStates.stateHash, stateHash(input.state)), isNull(swiggyOAuthStates.consumedAt), gt(swiggyOAuthStates.expiresAt, new Date())))
      .limit(1);
    if (!stateRow) throw new Error('Invalid or expired Swiggy OAuth state');

    const response = await fetch(new URL('/auth/token', env.SWIGGY_MCP_BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: stateRow.codeVerifier,
        client_id: env.SWIGGY_CLIENT_ID,
        redirect_uri: stateRow.redirectUri
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.access_token) {
      logger.warn('Swiggy OAuth token exchange failed', { status: response.status, userId: stateRow.userId });
      throw new Error('Swiggy authorization failed during token exchange');
    }

    const expiresAt = new Date(Date.now() + Math.max(Number(payload.expires_in ?? 0) - 60, 0) * 1000);
    const now = new Date();
    await db
      .insert(swiggyConnections)
      .values({
        userId: stateRow.userId,
        accessTokenCiphertext: encryptToken(String(payload.access_token)),
        scope: typeof payload.scope === 'string' ? payload.scope : null,
        tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
        expiresAt,
        status: 'active',
        lastAuthorizedAt: now,
        revokedAt: null,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: swiggyConnections.userId,
        set: {
          accessTokenCiphertext: encryptToken(String(payload.access_token)),
          scope: typeof payload.scope === 'string' ? payload.scope : null,
          tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
          expiresAt,
          status: 'active',
          lastAuthorizedAt: now,
          revokedAt: null,
          updatedAt: now
        }
      });

    await db.update(swiggyOAuthStates).set({ consumedAt: now }).where(eq(swiggyOAuthStates.id, stateRow.id));
    return { userId: stateRow.userId, expiresAt: expiresAt.toISOString() };
  }

  async completeStubAuthorization(state: string): Promise<{ userId: string; expiresAt: string }> {
    assertEnabled();
    if (!isStubMode()) throw new Error('Swiggy stub authorization is not enabled');

    const [stateRow] = await db
      .select()
      .from(swiggyOAuthStates)
      .where(and(eq(swiggyOAuthStates.stateHash, stateHash(state)), isNull(swiggyOAuthStates.consumedAt), gt(swiggyOAuthStates.expiresAt, new Date())))
      .limit(1);
    if (!stateRow) throw new Error('Invalid or expired Swiggy OAuth state');

    const result = await upsertStubConnection(stateRow.userId);
    await db.update(swiggyOAuthStates).set({ consumedAt: new Date() }).where(eq(swiggyOAuthStates.id, stateRow.id));
    return result;
  }

  async status(userId: string): Promise<{ connected: boolean; status: string; expiresAt?: string; selectedAddress?: unknown; connectPath: string }> {
    if (!env.SWIGGY_MCP_ENABLED) return { connected: false, status: 'disabled', connectPath: '/auth/swiggy/start' };

    const [connection] = await db.select().from(swiggyConnections).where(eq(swiggyConnections.userId, userId)).limit(1);
    const [selectedAddress] = await db
      .select()
      .from(swiggyDeliveryPreferences)
      .where(eq(swiggyDeliveryPreferences.userId, userId))
      .limit(1);
    const connected = Boolean(connection && connection.status === 'active' && connection.expiresAt > new Date());
    return {
      connected,
      status: connection?.status ?? 'not_connected',
      expiresAt: connection?.expiresAt.toISOString(),
      selectedAddress: selectedAddress
        ? {
            addressId: selectedAddress.addressId,
            label: selectedAddress.label,
            displayText: selectedAddress.displayText,
            selectedAt: selectedAddress.selectedAt.toISOString()
          }
        : null,
      connectPath: '/auth/swiggy/start'
    };
  }

  async disconnect(userId: string): Promise<void> {
    const [connection] = await db.select().from(swiggyConnections).where(eq(swiggyConnections.userId, userId)).limit(1);
    if (!connection) return;
    if (!isStubMode()) {
      try {
        await fetch(new URL('/auth/logout', env.SWIGGY_MCP_BASE_URL), {
          method: 'POST',
          headers: { Authorization: `Bearer ${decryptToken(connection.accessTokenCiphertext)}` }
        });
      } catch (error) {
        logger.warn('Swiggy logout call failed', { userId, error: (error as Error).message });
      }
    }
    await db
      .update(swiggyConnections)
      .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(swiggyConnections.userId, userId));
  }

  async selectDeliveryAddress(input: {
    userId: string;
    addressId: string;
    label?: string;
    displayText?: string;
  }): Promise<{ addressId: string; label?: string; displayText?: string }> {
    const now = new Date();
    await db
      .insert(swiggyDeliveryPreferences)
      .values({
        userId: input.userId,
        addressId: input.addressId,
        label: input.label,
        displayText: input.displayText,
        selectedAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: swiggyDeliveryPreferences.userId,
        set: {
          addressId: input.addressId,
          label: input.label,
          displayText: input.displayText,
          selectedAt: now,
          updatedAt: now
        }
      });
    return { addressId: input.addressId, label: input.label, displayText: input.displayText };
  }

  async getAddresses(userId: string): Promise<unknown> {
    return this.callTool({ userId, server: 'im', toolName: 'get_addresses', toolArguments: {} });
  }

  async callTool(input: {
    userId: string;
    server: string;
    toolName: string;
    toolArguments?: Record<string, unknown>;
    userConfirmed?: boolean;
  }): Promise<unknown> {
    assertEnabled();
    const server = asServer(input.server);
    if (!ALLOWED_TOOLS[server].has(input.toolName)) throw new Error(`Unsupported Swiggy tool for ${server}: ${input.toolName}`);
    if (CONFIRMATION_REQUIRED.has(input.toolName) && input.userConfirmed !== true) {
      return {
        status: 'needs_confirmation',
        message: 'Confirm the exact cart, amount, delivery address, and payment method with the user before calling this tool again.',
        toolName: input.toolName
      };
    }

    const [connection] = await db.select().from(swiggyConnections).where(eq(swiggyConnections.userId, input.userId)).limit(1);
    if (!connection || connection.status !== 'active' || connection.expiresAt <= new Date()) {
      return { status: 'auth_required', message: 'Swiggy is not connected or the session expired.', connectPath: '/auth/swiggy/start' };
    }

    if (isStubMode()) return stubToolResult(server, input.toolName, input.toolArguments ?? {});

    const response = await fetch(new URL(SERVER_PATH[server], env.SWIGGY_MCP_BASE_URL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${decryptToken(connection.accessTokenCiphertext)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: input.toolName,
          arguments: input.toolArguments ?? {}
        },
        id: randomBytes(8).toString('hex')
      }),
      signal: AbortSignal.timeout(env.SWIGGY_MCP_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401 || response.status === 419) {
      await db.update(swiggyConnections).set({ status: 'expired', updatedAt: new Date() }).where(eq(swiggyConnections.userId, input.userId));
      return { status: 'auth_required', message: 'Swiggy authorization expired. Please reconnect Swiggy.', connectPath: '/auth/swiggy/start' };
    }
    if (!response.ok) return { status: 'failed', httpStatus: response.status, error: payload };
    return payload;
  }
}
