export function compute(value) { return eval(value); }
export function lookup(userId) { return { query: `SELECT id FROM users WHERE id = '${userId}'`, parameters: [] }; }
