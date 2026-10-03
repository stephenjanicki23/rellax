import type { AttrKey } from '../engine/types';

const LABELS: Partial<Record<AttrKey, string>> = {
  wristPower: 'Wrist Shot Power', wristAccuracy: 'Wrist Shot Accuracy', slapPower: 'Slap Shot Power', slapAccuracy: 'Slap Shot Accuracy',
  oneTimer: 'One-Timer', offAwareness: 'Offensive Awareness', defAwareness: 'Defensive Awareness', decisionMaking: 'Decision Making',
  hockeySense: 'Hockey Sense', bodyChecking: 'Body Checking', stickChecking: 'Stick Checking', shotBlocking: 'Shot Blocking',
  defPositioning: 'Defensive Positioning', gPositioning: 'Positioning', reboundControl: 'Rebound Control', puckHandling: 'Puck Handling',
  highDanger: 'High-Danger Saves', lateral: 'Lateral Movement', puckControl: 'Puck Control', shotSelection: 'Shot Selection', clutch: 'Clutch',
};
/** Human-readable attribute name. */
export const attrLabel = (k: AttrKey): string => LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
