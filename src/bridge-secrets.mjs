// Secrets the bridge itself needs but no child process may ever see. This
// module is the FIRST import of server.mjs: ES modules evaluate their imports
// in order, depth first, and some later imports already start processes while
// loading (engines.mjs asks `agy models`), each inheriting process.env. Taking
// the values out here, before any of that, is what makes "no agent run can
// read it" true.

import { takeVapidKeyFromEnv } from "./vapid-env.mjs";

export const VAPID_ENV_KEY = takeVapidKeyFromEnv(process.env);
