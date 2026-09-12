/**
 * What the connection dialog will not let through.
 *
 * The pool fields took any number at all: a max of zero (which sqlx panics
 * on), a min above the max (which it refuses to build), or a five-thousand
 * that would open five thousand server threads. The backend clamps a stored
 * profile so an older one still connects, but a form that silently changes
 * what was typed is worse than one that says why (#279).
 */

/** FR-1.2.3: "configurable pool size (default: 5, max: 50)". */
export const POOL_MAX_LIMIT = 50;

export interface PoolProblems {
  min?: string;
  max?: string;
}

/** Why these pool sizes cannot be saved, if they cannot. */
export function validatePoolSizing(min: number, max: number): PoolProblems {
  const problems: PoolProblems = {};

  if (!Number.isInteger(max) || max < 1) {
    problems.max = "At least one connection is needed to run anything.";
  } else if (max > POOL_MAX_LIMIT) {
    problems.max = `${POOL_MAX_LIMIT} is the most. Every pooled connection is a server thread, and a few `
      + "profiles at more than this is already past what most servers allow one client.";
  }

  if (!Number.isInteger(min) || min < 0) {
    problems.min = "Cannot be negative. Use 0 to open connections only as they are needed.";
  } else if (problems.max === undefined && min > max) {
    problems.min = `Cannot be more than the maximum (${max}).`;
  }

  return problems;
}
