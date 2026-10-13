import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUrl, {
    dbName: config.dbName,
    // Fail fast on Vercel: the free-tier function times out at ~10s, so an
    // 8s server-selection wait guarantees a cold-start timeout. 4.5s leaves
    // room for the upstream call + JSON response in the same invocation.
    serverSelectionTimeoutMS: Number(process.env.MONGO_TIMEOUT_MS || 4500),
    maxPoolSize: config.mongoMaxPool,
  });
  const { name, host } = mongoose.connection;
  console.log(`[db] connected to ${host}/${name}`);
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

let connPromise = null;

/**
 * Connect at most once per process. Local dev calls this at boot; on Vercel
 * every cold start re-runs this module and each warm instance reuses its own
 * connection. A failed attempt clears the cache so the next request retries.
 */
export function connectDbOnce() {
  if (!connPromise) {
    connPromise = connectDb().catch((err) => {
      connPromise = null;
      throw err;
    });
  }
  return connPromise;
}
