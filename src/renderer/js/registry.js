/**
 * @file registry.js
 * @brief Command registry shared by every command module.
 *
 * Each command module calls `def('NAME ALIAS1 ALIAS2', handler, options)` once per command while it
 * is imported (see commands.js). The registry stores the handler under its canonical name and keeps
 * a lower-case alias table so the command line can resolve "l" -> LINE.
 *
 * Conventions used by the command modules:
 *   - one class per module, with a static `register()` that calls `def(...)` for every command
 *   - handlers are `async (c) => { ... }` where `c` is the command context (see app.js)
 *   - a handler stops its command by returning, or by throwing `CmdError` for a user-facing error
 */

/* ============================================================================================
 * 1. CONSTANTS AND ERROR TYPE
 * ========================================================================================== */

/** Returned by prompts when the user cancels (Esc); handlers must stop when they receive it. */
export const CANCEL = Symbol('cancel');

/** Throw from a command handler to report a user-facing error message and end the command. */
export class CmdError extends Error {}

/* ============================================================================================
 * 2. REGISTRY CLASS
 * ========================================================================================== */

/**
 * Holds every registered command.
 * One shared instance (`registry`) exists; the flat exports below point into it.
 */
export class CommandRegistry {
  constructor() {
    /** @type {Record<string, {fn: Function, name: string}>} canonical name -> command record */
    this.commands = {};
    /** @type {Record<string, string>} lower-case alias or name -> canonical name */
    this.aliases = {};
    /** @type {Record<string, any>} arguments a menu item passes to its command */
    this.menuArgs = {};
  }

  /**
   * Registers a command.
   * @param {string} names space separated: first token = canonical name, the rest are aliases
   * @param {Function} fn handler `async (c) => void`
   * @param {object} [opts] extra properties stored on the command record (for example `desc`)
   */
  define(names, fn, opts = {}) {
    const [name, ...al] = names.split(/\s+/);
    this.commands[name] = { fn, name, ...opts };
    this.aliases[name.toLowerCase()] = name;
    for (const a of al) this.aliases[a.toLowerCase()] = name;
  }

  /**
   * Adds one more alias for an already registered (or later registered) command.
   * @param {string} a the alias as typed by the user
   * @param {string} name the canonical command name
   */
  alias(a, name) {
    this.aliases[a.toLowerCase()] = name;
  }
}

/** The one registry instance used by the whole program. */
export const registry = new CommandRegistry();

/* ============================================================================================
 * 3. COMPATIBILITY EXPORTS
 * ========================================================================================== */

export const COMMANDS = registry.commands;
export const ALIASES = registry.aliases;
export const MENU_ARGS = registry.menuArgs;

/** Registers a command, see {@link CommandRegistry#define}. */
export const def = (names, fn, opts) => registry.define(names, fn, opts);

/** Adds an alias, see {@link CommandRegistry#alias}. */
export const alias = (a, name) => registry.alias(a, name);
