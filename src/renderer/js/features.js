/** Build-time product features. Source/development runs default to the full 3D edition. */
export const EDITION = typeof __MACCAD_EDITION__ === 'undefined' ? '3d' : __MACCAD_EDITION__;
export const HAS_3D = typeof __MACCAD_HAS_3D__ === 'undefined' ? true : __MACCAD_HAS_3D__;
export const AI_MODE = typeof __MACCAD_AI_MODE__ === 'undefined' ? 'user-managed' : __MACCAD_AI_MODE__;

export const commandAvailable = (command) => !command || command.feature !== '3d' || HAS_3D;
export const unavailableMessage = () => 'This command requires the MacCAD 2027 3D edition.';
