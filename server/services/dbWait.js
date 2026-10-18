import mongoose from 'mongoose';

/**
 * BOUNDED wait for the MongoDB connection.
 *
 * Public GET routes deliberately do NOT block on the DB (they must answer
 * even when MongoDB is unreachable), but instantly fast-failing made every
 * Vercel cold-start response DEGRADED: custom markets vanished from the
 * grid/live board for that request and the frontend - polling across many
 * instances - saw them flicker in and out. Atlas typically connects in
 * well under 2s, so callers wait a short, bounded moment first and only
 * fast-fail when the DB is genuinely unreachable.
 *
 * @param {number} budgetMs max time to wait
 * @returns {Promise<boolean>} true when the connection is up
 */
export function waitForDb(budgetMs = 2000) {
  if (mongoose.connection.readyState === 1) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      mongoose.connection.removeListener('open', onOpen);
      mongoose.connection.removeListener('error', onError);
      resolve(ok);
    };
    const onOpen = () => done(true);
    // A failed connect attempt will not succeed within this request - stop
    // waiting immediately so the route can degrade fast.
    const onError = () => done(false);
    const timer = setTimeout(() => done(mongoose.connection.readyState === 1), budgetMs);
    mongoose.connection.once('open', onOpen);
    mongoose.connection.once('error', onError);
  });
}
