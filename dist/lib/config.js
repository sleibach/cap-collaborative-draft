'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.collabConfig = collabConfig;
const cds = require("@sap/cds");
/**
 * Returns the plugin's runtime configuration from cds.env.collab.
 */
function collabConfig() {
    return cds.env.collab ?? {};
}
