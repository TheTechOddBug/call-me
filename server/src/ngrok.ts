/**
 * ngrok tunnel management for exposing local webhooks to phone providers
 */

import ngrok from '@ngrok/ngrok';

let listener: ngrok.Listener | null = null;
let currentPort: number | null = null;
let currentUrl: string | null = null;
let intentionallyClosed = false;
let reconnectAttempts = 0;
let reconnecting = false;
const maxReconnectAttempts = 10;
const baseReconnectDelayMs = 2000;
let onUrlChangedCallback: ((url: string) => void) | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start ngrok tunnel to expose local port
 * @param port Local port to expose
 * @returns Public ngrok URL
 */
export async function startNgrok(port: number, onUrlChanged?: (url: string) => void): Promise<string> {
  // Clean up any leaked in-process listeners from a previous crash
  try { await ngrok.kill(); } catch { /* ignore */ }

  intentionallyClosed = false;
  reconnectAttempts = 0;
  currentPort = port;
  onUrlChangedCallback = onUrlChanged || null;
  return doStartNgrok(port);
}

async function doStartNgrok(port: number): Promise<string> {
  const authtoken = process.env.CALLME_NGROK_AUTHTOKEN;

  if (!authtoken) {
    throw new Error(
      'CALLME_NGROK_AUTHTOKEN is required.\n' +
      'Get a free auth token at https://dashboard.ngrok.com/get-started/your-authtoken'
    );
  }

  const domain = process.env.CALLME_NGROK_DOMAIN || undefined;

  try {
    listener = await ngrok.forward({
      addr: port,
      authtoken,
      domain,
      onStatusChange: (status: string) => {
        console.error(`[ngrok] Status: ${status}`);
        if (status === 'closed' && !intentionallyClosed) {
          attemptReconnect();
        }
      },
    });
  } catch (error: any) {
    // ERR_NGROK_334: domain already bound by stale session
    if (domain && error?.message?.includes('ERR_NGROK_334')) {
      console.error('[ngrok] Domain in use by stale session, attempting cleanup...');
      try { await ngrok.disconnect(); } catch { /* ignore */ }
      try { await ngrok.kill(); } catch { /* ignore */ }
      // Retry once
      listener = await ngrok.forward({
        addr: port,
        authtoken,
        domain,
        onStatusChange: (status: string) => {
          console.error(`[ngrok] Status: ${status}`);
          if (status === 'closed' && !intentionallyClosed) {
            attemptReconnect();
          }
        },
      });
    } else {
      throw error;
    }
  }

  const url = listener.url();
  if (!url) {
    throw new Error('Failed to get ngrok URL');
  }

  currentUrl = url;
  reconnectAttempts = 0;  // Reset on success
  console.error(`[ngrok] Tunnel established: ${url}`);

  // Monitor for disconnection
  monitorTunnel();

  return url;
}

/**
 * Monitor tunnel health and reconnect if needed
 */
async function monitorTunnel(): Promise<void> {
  // Clear any previous health check interval to prevent leaks across reconnects
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }

  // Check tunnel health periodically
  healthCheckInterval = setInterval(async () => {
    const checkInterval = healthCheckInterval!;
    if (intentionallyClosed) {
      clearInterval(checkInterval);
      return;
    }

    // Check if listener is still valid
    if (!listener || !currentUrl) {
      clearInterval(checkInterval);
      console.error('[ngrok] Tunnel lost, attempting reconnect...');
      attemptReconnect();
      return;
    }

    // Actually verify the tunnel works by hitting the health endpoint
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${currentUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
    } catch (error) {
      clearInterval(checkInterval);
      console.error('[ngrok] Tunnel health check failed:', error);
      attemptReconnect();
    }
  }, 30000);  // Check every 30 seconds
}

/**
 * Attempt to reconnect the ngrok tunnel
 */
async function attemptReconnect(): Promise<void> {
  if (reconnecting || intentionallyClosed || currentPort === null) {
    return;
  }
  reconnecting = true;

  try {
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.error(`[ngrok] Max reconnect attempts (${maxReconnectAttempts}) reached, giving up`);
      return;
    }

    reconnectAttempts++;
    const delay = baseReconnectDelayMs * Math.pow(2, reconnectAttempts - 1);
    console.error(`[ngrok] Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${delay}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    if (intentionallyClosed) {
      console.error('[ngrok] Reconnect cancelled - tunnel intentionally closed');
      return;
    }

    // Clean up old listener
    if (listener) {
      try {
        await listener.close();
      } catch (e) {
        // Ignore close errors
      }
      listener = null;
    }

    const previousUrl = currentUrl;
    const newUrl = await doStartNgrok(currentPort);
    console.error(`[ngrok] Reconnected successfully: ${newUrl}`);

    // Notify if URL changed (free tier gets new URL on each reconnect)
    if (newUrl !== previousUrl) {
      console.error(`[ngrok] WARNING: Tunnel URL changed from ${previousUrl} to ${newUrl}`);
      console.error('[ngrok] Phone provider webhooks may need to be updated');
      if (onUrlChangedCallback) {
        onUrlChangedCallback(newUrl);
      }
    }
  } catch (error) {
    console.error('[ngrok] Reconnect failed:', error);
    // Try again (reconnecting flag will be reset in finally)
    reconnecting = false;
    attemptReconnect();
    return;
  } finally {
    reconnecting = false;
  }
}

/**
 * Get the current ngrok URL
 */
export function getNgrokUrl(): string | null {
  return currentUrl;
}

/**
 * Check if ngrok tunnel is active
 */
export function isNgrokConnected(): boolean {
  return listener !== null && !intentionallyClosed;
}

/**
 * Stop ngrok tunnel
 */
export async function stopNgrok(): Promise<void> {
  intentionallyClosed = true;
  if (listener) {
    await listener.close();
    listener = null;
  }
  currentUrl = null;
}
