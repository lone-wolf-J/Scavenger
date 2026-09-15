// MCP-backed provider transport (stub + contract).
//
// Architecture: a portals entry may declare
//
//   provider: dice
//   transport: mcp
//   mcp: { server: 'dice', tool: 'search_jobs', args: { query: '...', location: 'US' } }
//
// so a board backed by an official MCP server (Dice, ZipRecruiter, ...) can
// replace HTML scraping without changing the normalized Job contract. The
// plain `node scan.mjs` runtime has no MCP client session, so dispatch here
// reports UNAVAILABLE with actionable guidance instead of failing obscurely.
// An MCP-capable runner (Claude Code / OpenCode with the board's MCP server
// configured) resolves the entry by calling the declared tool itself and
// feeding the listings through normalizeJob().
//
// This keeps MCP out of the scanner core: HTML, API, MCP and ATS providers
// all converge on the same normalized Job object.

import { fail } from './provider-result.mjs';

/** True when an entry explicitly requests MCP transport. */
export function isMcpEntry(entry) {
  return entry?.transport === 'mcp';
}

/**
 * Describe how an MCP-capable runner should satisfy the entry.
 * Pure (no I/O) so runners and tests can use it without a session.
 */
export function describeMcpCall(entry) {
  const mcp = entry?.mcp && typeof entry.mcp === 'object' ? entry.mcp : {};
  return {
    server: mcp.server || String(entry?.provider || ''),
    tool: mcp.tool || 'search_jobs',
    args: {
      query: entry?.query || entry?.search || '',
      location: entry?.location || 'United States',
      ...(mcp.args && typeof mcp.args === 'object' ? mcp.args : {}),
    },
  };
}

/** Plain-node dispatch: always UNAVAILABLE (no MCP session here). */
export async function runMcpProvider(entry) {
  const call = describeMcpCall(entry);
  return fail(
    'UNAVAILABLE',
    `mcp transport needs an MCP-capable runner with server "${call.server}" configured (tool "${call.tool}"); plain node scan cannot call it — falling back to HTML/API provider`,
    { metadata: { provider: entry?.provider || 'unknown', transport: 'mcp', ...call } },
  );
}
