import { useCallback, useEffect, useMemo, useState } from "react";
import { type CountPlan, planCount } from "../lib/row-count";
import { runStatement } from "../lib/run-statement";

/**
 * How many rows the query would have returned, when the grid only has a page.
 *
 * Split out of ResultsGrid (#406). Two answers, because they cost different
 * amounts: the engine's own estimate is free for a whole-table read and is
 * fetched unasked, while an exact count is a full scan and only runs when the
 * user asks (#402).
 */

export interface RowCount {
  /** Null until something is known. `exact: false` is the engine's estimate. */
  total: { value: number; exact: boolean } | null;
  /** What a count would cost here, or why one cannot be made. */
  plan: CountPlan;
  counting: boolean;
  error: string | null;
  countExactly: () => Promise<void>;
}

export function useRowCount(
  connectionId: string | null | undefined,
  database: string | null | undefined,
  sql: string | null | undefined,
  /** Only a truncated result has a total worth asking about. */
  truncated: boolean,
): RowCount {
  const [total, setTotal] = useState<{ value: number; exact: boolean } | null>(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = useMemo(() => planCount(sql ?? "", database), [sql, database]);

  const read = useCallback(async (statement: string): Promise<number | null> => {
    if (!connectionId) return null;
    const results = await runStatement({
      connectionId,
      sql: statement,
      database: database ?? undefined,
      origin: "internal",
    });
    const value = Number(results[0]?.rows?.[0]?.[0]);
    return Number.isFinite(value) ? value : null;
  }, [connectionId, database]);

  useEffect(() => {
    setTotal(null);
    setError(null);
    if (!truncated || plan.kind !== "table") return;

    let cancelled = false;
    void (async () => {
      try {
        const value = await read(plan.estimateSql);
        if (!cancelled && value !== null) setTotal({ value, exact: false });
      } catch {
        // An estimate nobody asked for is not worth reporting a failure over.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [truncated, plan, read]);

  const countExactly = useCallback(async () => {
    if (plan.kind === "none") return;
    setCounting(true);
    setError(null);
    try {
      const value = await read(plan.exactSql);
      if (value !== null) setTotal({ value, exact: true });
    } catch (e) {
      setError(`Count failed: ${String(e)}`);
    } finally {
      setCounting(false);
    }
  }, [plan, read]);

  return { total, plan, counting, error, countExactly };
}
