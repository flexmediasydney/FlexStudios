/**
 * usePermissions.test.jsx — QC-iter2-W3 F-C-010 regression test.
 *
 * Pins the bootstrap-state contract that ShortlistingCommandCenter +
 * DroneCommandCenter rely on to avoid the "Access denied" flash on every
 * full reload.
 *
 * What we cover:
 *   1. While the underlying useCurrentUser() query is loading, usePermissions
 *      exposes `isLoading: true` AND `isAdminOrAbove: false`. Callers must
 *      branch on `isLoading` first to avoid rendering the denied state during
 *      bootstrap.
 *   2. Once the user resolves with role=master_admin, `isLoading: false` AND
 *      `isAdminOrAbove: true`.
 *   3. Once the user resolves with role=manager (denied), `isLoading: false`
 *      AND `isAdminOrAbove: false`.
 *   4. The bootstrap state fixture (Loader skeleton, NOT Access Denied) — a
 *      tiny harness component asserts the expected branch order.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stub @supabase/supabase-js so module load doesn't crash on missing env.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(),
    auth: { getUser: vi.fn(), signOut: vi.fn() },
    functions: { invoke: vi.fn() },
    channel: vi.fn(),
    removeChannel: vi.fn(),
    storage: { from: vi.fn() },
    rpc: vi.fn(),
  })),
}));

vi.mock("@/api/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      rpc: vi.fn(async () => ({ data: {} })),
      auth: { me: vi.fn(async () => null), redirectToLogin: vi.fn() },
      functions: { invoke: vi.fn() },
      entities: new Proxy(
        {},
        { get: () => ({ filter: vi.fn(async () => []), list: vi.fn(async () => []) }) },
      ),
    },
  };
});

// Drives useCurrentUser() — flip these between tests to model bootstrap
// vs resolved-master_admin vs resolved-manager states.
const authState = {
  user: null,
  isLoadingAuth: true,
};
vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => authState,
}));

import { usePermissions } from "../PermissionGuard";

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // eslint-disable-next-line react/prop-types
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("usePermissions — F-C-010 bootstrap signal", () => {
  beforeEach(() => {
    authState.user = null;
    authState.isLoadingAuth = true;
  });

  it("during auth bootstrap: isLoading=true and isAdminOrAbove=false (caller must NOT show Access Denied)", () => {
    authState.user = null;
    authState.isLoadingAuth = true;
    const { result } = renderHook(() => usePermissions(), { wrapper: makeWrapper() });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isResolved).toBe(false);
    expect(result.current.isAdminOrAbove).toBe(false);
  });

  it("resolved master_admin: isLoading=false and isAdminOrAbove=true", () => {
    authState.user = { id: "u1", role: "master_admin" };
    authState.isLoadingAuth = false;
    const { result } = renderHook(() => usePermissions(), { wrapper: makeWrapper() });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isResolved).toBe(true);
    expect(result.current.isAdminOrAbove).toBe(true);
  });

  it("resolved manager: isLoading=false and isAdminOrAbove=false (denied AFTER bootstrap)", () => {
    authState.user = { id: "u2", role: "manager" };
    authState.isLoadingAuth = false;
    const { result } = renderHook(() => usePermissions(), { wrapper: makeWrapper() });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAdminOrAbove).toBe(false);
  });
});

describe("usePermissions — gate harness mirrors page anti-pattern fix", () => {
  // Mirrors the gating logic in ShortlistingCommandCenter.jsx + DroneCommandCenter.jsx
  function GateHarness() {
    const { isAdminOrAbove, isLoading } = usePermissions();
    if (isLoading) {
      return <div data-testid="harness-loading">Loading…</div>;
    }
    if (!isAdminOrAbove) {
      return <div data-testid="harness-denied">Access denied</div>;
    }
    return <div data-testid="harness-content">Admin content</div>;
  }

  beforeEach(() => {
    authState.user = null;
    authState.isLoadingAuth = true;
  });

  it("renders LoadingSkeleton during bootstrap (not Access Denied) — F-C-010 regression", () => {
    authState.user = null;
    authState.isLoadingAuth = true;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GateHarness />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("harness-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("harness-denied")).not.toBeInTheDocument();
    expect(screen.queryByTestId("harness-content")).not.toBeInTheDocument();
  });

  it("renders content for resolved master_admin", () => {
    authState.user = { id: "u1", role: "master_admin" };
    authState.isLoadingAuth = false;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GateHarness />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("harness-content")).toBeInTheDocument();
    expect(screen.queryByTestId("harness-denied")).not.toBeInTheDocument();
  });

  it("renders Access Denied for resolved manager", () => {
    authState.user = { id: "u2", role: "manager" };
    authState.isLoadingAuth = false;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GateHarness />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("harness-denied")).toBeInTheDocument();
    expect(screen.queryByTestId("harness-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("harness-content")).not.toBeInTheDocument();
  });
});
