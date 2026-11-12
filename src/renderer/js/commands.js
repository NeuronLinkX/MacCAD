/**
 * @file commands.js
 * @brief Command registry entry point.
 *
 * Importing this module imports every command module, and each of those registers its commands
 * with the shared registry (see registry.js). Keep the list below in sync when a command module is
 * added; the order only matters for aliases that are defined twice (the later module wins).
 */

/* ============================================================================================
 * 1. COMMAND MODULES (importing them registers their commands)
 * ========================================================================================== */
import './commands_draw.js'; //    drawing: LINE, CIRCLE, PLINE ...
import './commands_modify.js'; //  editing: MOVE, COPY, TRIM, FILLET ...
import './commands_misc.js'; //    annotation, blocks, layers, queries
import './commands_more.js'; //    further 2D commands
import './commands_sys.js'; //     system: settings, files, plotting, view
import './commands_3d.js'; //      3D solids
import './commands_alias.js'; //   extra command-line aliases (must come after the modules above)
import './exchange3d.js'; //       STEP / STL / OBJ import and export
import './commands_hybrid.js';
import './commands_studio.js'; //  materials and scenes
import './commands_license.js'; // trial / licence window
import './ai.js'; //               AI assistant commands

/* ============================================================================================
 * 2. PUBLIC API
 * ========================================================================================== */
export { COMMANDS, ALIASES, CANCEL, CmdError } from './registry.js';
