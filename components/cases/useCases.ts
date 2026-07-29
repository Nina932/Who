"use client";

import { useCallback, useEffect, useState } from "react";
import type { CaseView } from "@/lib/cases";

/**
 * One loader for every case surface.
 *
 * Every mutation returns the whole re-projected ledger rather than patching
 * state locally, because a single appended event can change the turn on a case
 * that is not the one you touched — an unblock upstream, a value restated. A
 * client that patched optimistically would drift out of agreement with the log
 * it claims to be a view of.
 */
export function useCases() {
  const [cases, setCases] = useState<CaseView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cases", { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status}`);
      const body = (await response.json()) as { cases: CaseView[] };
      setCases(body.cases);
      setError(null);
    } catch {
      setError("Could not read the case ledger.");
      setCases([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { cases?: CaseView[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `${response.status}`);
      if (body.cases) setCases(body.cases);
      return body;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not go through.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { cases, busy, error, load, act };
}
