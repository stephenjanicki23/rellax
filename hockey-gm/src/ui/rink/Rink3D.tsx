/**
 * 3D broadcast view of the live rink. Draws exactly what the 2D rink draws
 * (the same RinkMotion bodies and puck, which follow the engine's positions)
 * as a lit arena: ice with its markings, boards and glass, nets, a crowd,
 * and skaters in their team's colours with a ring under each one.
 *
 * Rink coordinates are feet (x 0..200 along the ice, y 0..85 across); in the
 * scene x runs the same way, z = y - 42.5 and y is up.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RINK, attackDir, type RinkPlayer } from './director';
import type { RinkMotion } from './motion';

export type Cam3D = 'behind' | 'broadcast';

interface Rink3DProps {
  motion: RinkMotion;
  meta: Map<number, RinkPlayer>;
  /** [primary, secondary] colours, home then away. */
  colors: readonly [readonly [string, string], readonly [string, string]];
  abbr: [string, string];
  /** Home team's logo URL, painted at centre ice when the browser can load it. */
  logo?: string;
  /** Team names (e.g. "Bruins"), for the dasher boards. */
  names: [string, string];
  score: [number, number];
  period: number;
  /** Goal light on behind the net this team scored on. */
  light: 0 | 1 | null;
  /** The team that just scored (while the goal card is up): celebrations and the goal camera. */
  goalTeam: 0 | 1 | null;
  /** A goal replay is playing (switches to the replay camera). */
  replaying: boolean;
  onFail: () => void;
}

const W = RINK.w;
const H = RINK.h;
const CORNER = 28;
/** Players are drawn a little larger than life so numbers read from the broadcast camera. */
const SCALE = 1.35;

const toScene = (x: number, y: number) => new THREE.Vector3(x - RINK.cx, 0, y - RINK.cy);

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x0 = -w / 2;
  const y0 = -h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.absarc(x0 + w - r, y0 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x0 + w, y0 + h - r);
  s.absarc(x0 + w - r, y0 + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x0 + r, y0 + h);
  s.absarc(x0 + r, y0 + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + r);
  s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A band around the rink outline (inner offset a, outer offset b), extruded upward from y0 by height h. */
function band(a: number, b: number, h: number, y0: number, mat: THREE.Material): THREE.Mesh {
  const outer = roundedRect(W + 2 * b, H + 2 * b, CORNER + b);
  const inner = roundedRect(W + 2 * a, H + 2 * a, CORNER + a);
  outer.holes.push(new THREE.Path(inner.getPoints(48)));
  const g = new THREE.ExtrudeGeometry(outer, { depth: h, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.y = y0;
  return m;
}

/**
 * The ice: white sheet with the real markings, painted once on a canvas. The home team's logo
 * (when it could be loaded) is painted at centre ice under the lines, as in a real rink;
 * otherwise a crest with the team's abbreviation.
 */
function iceTexture(homeAbbr: string, homeColor: string, logo?: HTMLImageElement): THREE.CanvasTexture {
  const PX = 10;
  const c = document.createElement('canvas');
  c.width = W * PX;
  c.height = H * PX;
  const g = c.getContext('2d')!;
  g.scale(PX, PX);
  g.fillStyle = '#f4f8fb';
  g.fillRect(0, 0, W, H);
  // Faint skate scratches and snow.
  for (let i = 0; i < 1400; i++) {
    g.strokeStyle = `rgba(160,180,200,${0.04 + Math.random() * 0.06})`;
    g.lineWidth = 0.05 + Math.random() * 0.08;
    const x = Math.random() * W;
    const y = Math.random() * H;
    const a = Math.random() * Math.PI;
    const l = 1 + Math.random() * 6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  const RED = '#c8102e';
  const BLUE = '#1f4fa8';
  // Centre-ice logo (painted under the lines).
  g.save();
  if (logo) {
    const iw = logo.naturalWidth || 300;
    const ih = logo.naturalHeight || 300;
    const size = 24;
    const k = size / Math.max(iw, ih);
    g.globalAlpha = 0.95;
    g.drawImage(logo, RINK.cx - (iw * k) / 2, RINK.cy - (ih * k) / 2, iw * k, ih * k);
  } else {
    g.globalAlpha = 0.85;
    g.fillStyle = homeColor;
    g.beginPath();
    g.arc(RINK.cx, RINK.cy, 9, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#fff';
    g.font = '800 6px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(homeAbbr, RINK.cx, RINK.cy + 0.3);
  }
  g.restore();
  // Centre line, blue lines, goal lines.
  g.fillStyle = RED;
  g.fillRect(RINK.cx - 0.5, 0, 1, H);
  g.fillStyle = BLUE;
  g.fillRect(RINK.cx - 25 - 0.5, 0, 1, H);
  g.fillRect(RINK.cx + 25 - 0.5, 0, 1, H);
  g.fillStyle = RED;
  g.fillRect(RINK.goalL - 0.08, 0, 0.17, H);
  g.fillRect(RINK.goalR - 0.08, 0, 0.17, H);
  // Centre circle.
  g.strokeStyle = BLUE;
  g.lineWidth = 0.17;
  g.beginPath();
  g.arc(RINK.cx, RINK.cy, 15, 0, Math.PI * 2);
  g.stroke();
  // Faceoff circles and dots.
  g.strokeStyle = RED;
  g.fillStyle = RED;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const x = RINK.cx + sx * 69;
      const y = RINK.cy + sy * 22;
      g.lineWidth = 0.17;
      g.beginPath();
      g.arc(x, y, 15, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(x, y, 1, 0, Math.PI * 2);
      g.fill();
      // Hash marks.
      for (const hy of [-1, 1]) for (const hx of [-1, 1]) g.fillRect(x + hx * 2.9 - 0.08, y + hy * 15, 0.17, hy * 2);
      g.beginPath();
      g.arc(RINK.cx + sx * 20, y, 1, 0, Math.PI * 2);
      g.fill();
    }
  // Creases.
  for (const [gx, d] of [
    [RINK.goalL, 1],
    [RINK.goalR, -1],
  ] as const) {
    g.fillStyle = 'rgba(90,163,224,0.7)';
    g.beginPath();
    g.moveTo(gx, RINK.cy - 4);
    g.lineTo(gx + d * 4.5, RINK.cy - 4);
    g.arc(gx + d * 4.5, RINK.cy, 4, -Math.PI / 2, Math.PI / 2, d < 0);
    g.lineTo(gx, RINK.cy + 4);
    g.closePath();
    g.fill();
    g.strokeStyle = RED;
    g.lineWidth = 0.17;
    g.stroke();
  }
  // Outside the rounded boards is transparent.
  g.globalCompositeOperation = 'destination-in';
  g.beginPath();
  g.roundRect(0, 0, W, H, CORNER);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function textOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.62 ? '#111111' : '#ffffff';
}

interface Skater {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  ring: THREE.Mesh;
  ring2: THREE.Mesh;
  phase: number;
  goalie: boolean;
  team: 0 | 1;
  /** Speed last frame (for hard stops), and how far into a celebration he is. */
  lastSp: number;
  cheer: number;
}

const box = (w: number, h: number, d: number, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};
/** A rounded limb: a capsule centred at (x, y, z), `len` long between the caps. */
const limb = (r: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};
const ringBand = (r: number, h: number, mat: THREE.Material, x: number, y: number) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14, 1, true), mat);
  m.position.set(x, y, 0);
  return m;
};

/**
 * A natural skin tone, picked per player from the full range of real skin tones (by id only:
 * nothing about the player is used to choose it).
 */
const SKIN_TONES = ['#f7dcc8', '#f1c9ad', '#e8b896', '#dba37f', '#c98d66', '#b07450', '#94603f', '#7a4b31', '#5f3a26', '#47291b'];
function skinTone(id: number): string {
  const h = Math.abs(Math.sin((id + 7) * 78.233) * 43758.5453) % 1;
  return SKIN_TONES[Math.floor(h * SKIN_TONES.length)];
}

/** Number on a transparent panel, for the back and chest of the jersey. */
function numberDecal(num: number | null, ink: string, outline: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  if (num !== null) {
    g.font = '800 92px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 12;
    g.strokeStyle = outline;
    g.strokeText(String(num), 64, 68);
    g.fillStyle = ink;
    g.fillText(String(num), 64, 68);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A rounded skater (or goalie) facing +x, feet at the origin, arms that can rise to celebrate. */
function buildSkater(p: RinkPlayer | undefined, team: 0 | 1, goalie: boolean, colors: readonly [string, string]): Skater {
  const [jersey, trim] = colors;
  const white = jersey.toLowerCase() === '#f4f4f2';
  const ringCol = white ? trim : jersey;
  const mat = (color: string, rough = 0.7, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const jm = mat(jersey, 0.75);
  const tm = mat(trim, 0.7);
  const pants = mat(white || lum(jersey) > 0.62 ? trim : '#14171c', 0.65);
  const glove = mat(white ? trim : lum(jersey) > 0.62 ? trim : jersey, 0.6);
  const black = mat('#0c0e11', 0.45);
  const steel = mat('#d7dde4', 0.25, 0.9);
  const pad = mat('#f5f4ef', 0.55);
  const helmetMat = mat(white ? trim : lum(jersey) > 0.62 ? trim : jersey, 0.25, 0.15);
  const ink = textOn(jersey);
  const numMat = new THREE.MeshStandardMaterial({ map: numberDecal(p?.number ?? null, ink === '#ffffff' && white ? trim : ink, trim), transparent: true, roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const hipY = goalie ? 2.3 : 2.75;
  const stance = goalie ? 0.62 : 0.4;
  const legs: THREE.Group[] = [];
  for (const z of [-stance, stance]) {
    const leg = new THREE.Group();
    leg.position.set(0, hipY, z);
    if (goalie) {
      // Leg pads with the team stripe, and skates.
      leg.add(box(0.95, hipY - 0.15, 0.85, pad, 0.18, -(hipY - 0.15) / 2, 0));
      leg.add(box(0.97, 0.18, 0.87, tm, 0.18, -hipY * 0.35, 0));
      leg.add(box(0.97, 0.18, 0.87, tm, 0.18, -hipY * 0.7, 0));
      leg.add(box(1.25, 0.22, 0.45, black, 0.25, -hipY + 0.12, 0));
    } else {
      leg.add(limb(0.32, 0.55, pants, 0, -0.55, 0));
      // Sock with a stripe.
      const sock = limb(0.25, 0.75, jm, 0.05, -1.55, 0);
      leg.add(sock);
      leg.add(ringBand(0.27, 0.16, tm, 0.05, -1.45));
      leg.add(box(1.1, 0.42, 0.42, black, 0.22, -hipY + 0.3, 0));
      leg.add(box(1.25, 0.07, 0.05, steel, 0.22, -hipY + 0.05, 0));
    }
    body.add(leg);
    legs.push(leg);
  }
  // Pants shell.
  const shell = limb(0.72, 0.35, pants, 0, hipY + 0.05, 0);
  shell.rotation.x = Math.PI / 2;
  shell.scale.set(1, 1.05, 0.95);
  body.add(shell);
  // Jersey: a rounded torso with hem and shoulder stripes, numbers on back and chest.
  const torsoR = goalie ? 0.95 : 0.78;
  const torso = limb(torsoR, goalie ? 1.1 : 1.0, jm, 0, hipY + 1.35, 0);
  torso.scale.set(0.82, 1, 1.12);
  body.add(torso);
  const hem = new THREE.Mesh(new THREE.CylinderGeometry(torsoR * 0.98, torsoR * 0.98, 0.22, 18, 1, true), tm);
  hem.scale.set(0.84, 1, 1.15);
  hem.position.y = hipY + 0.62;
  body.add(hem);
  const yoke = new THREE.Mesh(new THREE.CylinderGeometry(torsoR * 0.95, torsoR, 0.2, 18, 1, true), tm);
  yoke.scale.set(0.84, 1, 1.15);
  yoke.position.y = hipY + 2.05;
  body.add(yoke);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25), numMat);
  back.position.set(-torsoR * 0.84, hipY + 1.4, 0);
  back.rotation.y = -Math.PI / 2;
  body.add(back);
  const chest = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), numMat);
  chest.position.set(torsoR * 0.84, hipY + 1.6, 0.35);
  chest.rotation.y = Math.PI / 2;
  body.add(chest);
  // Neck and head: a face in his own skin tone inside the helmet (goalies: a painted mask with a cage).
  const skin = new THREE.MeshStandardMaterial({ color: skinTone(p?.id ?? 0), roughness: 0.75 });
  body.add(limb(0.24, 0.15, skin, 0, hipY + 2.45, 0));
  const headY = hipY + 2.95;
  if (goalie) {
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.6, 20, 14), pad);
    head.scale.set(1.08, 1, 0.95);
    head.position.set(0, headY, 0);
    head.castShadow = true;
    body.add(head);
    const paint = new THREE.Mesh(new THREE.SphereGeometry(0.61, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.35), tm);
    paint.scale.copy(head.scale);
    paint.position.copy(head.position);
    body.add(paint);
    for (let i = -2; i <= 2; i++) body.add(box(0.05, 0.6, 0.05, black, 0.6, hipY + 2.85, i * 0.13));
  } else {
    // Face (facing +x), with eyes so you can tell which way he's looking.
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), skin);
    face.scale.set(1, 1.08, 0.9);
    face.position.set(0.06, headY - 0.06, 0);
    face.castShadow = true;
    body.add(face);
    const eyeMat = new THREE.MeshStandardMaterial({ color: '#1a1410', roughness: 0.4 });
    for (const z of [-0.16, 0.16]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), eyeMat);
      eye.position.set(0.52, headY + 0.02, z);
      body.add(eye);
    }
    // Helmet shell: covers the top, sides and back, open at the face.
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.62, 22, 14, Math.PI + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.62), helmetMat);
    shell.scale.set(1.08, 1, 0.98);
    shell.position.set(0, headY + 0.02, 0);
    shell.castShadow = true;
    body.add(shell);
    // Brim over the forehead, and ear guards.
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.16, 20, 1, true, Math.PI / 2 - 0.95, 1.9), helmetMat);
    brim.position.set(0, headY + 0.24, 0);
    body.add(brim);
    for (const z of [-0.55, 0.55]) body.add(box(0.32, 0.36, 0.1, helmetMat, -0.02, headY - 0.08, z));
    if (p?.visor !== false) {
      // Visor: a clear, lightly tinted shield across the eyes.
      const visor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.66, 0.68, 0.32, 24, 1, true, Math.PI / 2 - 0.9, 1.8),
        new THREE.MeshPhysicalMaterial({ color: '#cfe2f3', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.38, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }),
      );
      visor.position.set(0, headY + 0.01, 0);
      body.add(visor);
    }
  }
  // Arms pivot at the shoulders so they can swing and rise.
  const shoulderY = hipY + 2.0;
  const sz = torsoR * 1.12 + 0.12;
  const arms: THREE.Group[] = [];
  for (const z of [-sz, sz]) {
    const arm = new THREE.Group();
    arm.position.set(0, shoulderY, z);
    arm.add(limb(0.26, 0.5, jm, 0, -0.45, 0));
    arm.add(ringBand(0.28, 0.14, tm, 0, -0.85));
    arm.add(limb(0.22, 0.45, jm, 0, -1.2, 0));
    arm.add(box(0.5, 0.45, 0.48, goalie ? pad : glove, 0, -1.7, 0));
    arm.rotation.z = goalie ? 0.35 : 0.55;
    body.add(arm);
    arms.push(arm);
  }
  // The stick rides in the right hand: from the glove down to a taped blade on the ice ahead.
  const armR = arms[1];
  const stick = new THREE.Group();
  stick.position.set(0, -1.75, 0);
  const shaftLen = goalie ? 3.6 : 4.4;
  stick.add(box(0.13, shaftLen, 0.13, black, 0, -shaftLen / 2, 0));
  stick.add(box(goalie ? 1.4 : 1.05, goalie ? 0.45 : 0.3, 0.08, pad, 0.42, -shaftLen + 0.05, 0));
  // Point the shaft down-forward in the body's frame, whatever the arm's swing.
  const want = new THREE.Vector3(goalie ? 0.25 : 0.45, -0.88, goalie ? 0.1 : -0.15).normalize();
  want.applyAxisAngle(new THREE.Vector3(0, 0, 1), -armR.rotation.z);
  stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), want);
  armR.add(stick);
  if (goalie) {
    // Blocker and catching glove.
    arms[1].add(box(0.25, 1.15, 0.85, pad, 0.2, -1.6, 0.25));
    const mitt = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.34, 16), glove);
    mitt.rotation.z = Math.PI / 2;
    mitt.position.set(0.25, -1.7, -0.3);
    arms[0].add(mitt);
  }
  body.scale.setScalar(SCALE);

  // Rings on the ice (team colour; gold when he has the puck).
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.7, 48), new THREE.MeshBasicMaterial({ color: ringCol, transparent: true, opacity: 0.9, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  root.add(ring);
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(3.1, 3.35, 48), new THREE.MeshBasicMaterial({ color: ringCol, transparent: true, opacity: 0.45, depthWrite: false }));
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.y = 0.035;
  root.add(ring2);
  return { root, body, legL: legs[0], legR: legs[1], armL: arms[0], armR: arms[1], ring, ring2, phase: Math.random() * 6, goalie, team, lastSp: 0, cheer: 0 };
}

function lum(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function buildNet(gx: number, d: 1 | -1): THREE.Group {
  const net = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: '#d0102a', roughness: 0.4, metalness: 0.3 });
  const post = (x: number, y: number, z: number, len: number, axis: 'x' | 'y' | 'z') => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, len, 10), red);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    m.castShadow = true;
    net.add(m);
  };
  post(0, 2, -3, 4, 'y');
  post(0, 2, 3, 4, 'y');
  post(0, 4, 0, 6, 'z');
  post(-d * 1.7, 0.1, -3, 3.4, 'x');
  post(-d * 1.7, 0.1, 3, 3.4, 'x');
  post(-d * 3.4, 0.1, 0, 6, 'z');
  const mesh = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.38, side: THREE.DoubleSide, wireframe: false });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), mesh);
  back.rotation.y = Math.PI / 2;
  back.position.set(-d * 2.6, 2, 0);
  back.rotation.z = 0;
  back.rotation.x = 0;
  back.rotateX(d * 0.35);
  net.add(back);
  for (const z of [-3, 3]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 4), mesh);
    side.position.set(-d * 1.7, 2, z);
    net.add(side);
  }
  const top = new THREE.Mesh(new THREE.PlaneGeometry(2, 6), mesh);
  top.rotation.x = -Math.PI / 2;
  top.rotation.z = Math.PI / 2;
  top.position.set(-d * 1, 3.95, 0);
  net.add(top);
  const p = toScene(gx, RINK.cy);
  net.position.set(p.x, 0, p.z);
  return net;
}

/** The crowd: rows of fans on tiers rising away from the glass. They bob in their seats and jump up for goals. */
function buildCrowd(home: string, away: string): { group: THREE.Group; update: (t: number, excite: number) => void } {
  const g = new THREE.Group();
  const tierMat = new THREE.MeshStandardMaterial({ color: '#1b2029', roughness: 0.9 });
  const rows = 10;
  const seats: { x: number; y: number; z: number; ph: number; fan: number }[] = [];
  for (let k = 0; k < rows; k++) {
    const off = 9 + k * 3;
    const y = 3.8 + k * 2.1;
    g.add(band(off - 1.5, off + 1.5, 0.6, y - 0.6, tierMat));
    const outline = roundedRect(W + 2 * off, H + 2 * off, CORNER + off);
    for (const p of outline.getSpacedPoints(Math.floor(outline.getLength() / 1.5))) {
      if (Math.random() < 0.07) continue;
      seats.push({ x: p.x + (Math.random() - 0.5) * 0.4, y, z: -p.y, ph: Math.random() * Math.PI * 2, fan: 0.5 + Math.random() });
    }
  }
  // Lower bowl railing glow.
  g.add(band(7.3, 7.6, 0.25, 3.6, new THREE.MeshBasicMaterial({ color: home })));
  const n = seats.length;
  const bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.42, 0.75, 2, 6), new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), n);
  const shirts = [home, home, home, home, '#ececec', '#2b2f36', '#53606e', away, '#9a2a2a', '#c9b27a'].map((c) => new THREE.Color(c));
  const skins = ['#f1c9a5', '#d9a77f', '#a8714f', '#7a4a32', '#e8b896'].map((c) => new THREE.Color(c));
  const m = new THREE.Matrix4();
  seats.forEach((s, i) => {
    bodies.setColorAt(i, shirts[Math.floor(Math.random() * shirts.length)].clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.12));
    heads.setColorAt(i, skins[Math.floor(Math.random() * skins.length)]);
    m.makeTranslation(s.x, s.y + 0.8, s.z);
    bodies.setMatrixAt(i, m);
    m.makeTranslation(s.x, s.y + 1.65, s.z);
    heads.setMatrixAt(i, m);
  });
  for (const im of [bodies, heads]) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    g.add(im);
  }
  let last = -1;
  const update = (t: number, excite: number) => {
    // 20 times a second is plenty for a crowd.
    if (t - last < 0.05) return;
    last = t;
    for (let i = 0; i < n; i++) {
      const s = seats[i];
      const amp = 0.06 + excite * 0.9 * s.fan;
      const lift = Math.max(0, Math.sin(t * (2 + excite * 5) * s.fan + s.ph)) * amp + excite * 0.35 * s.fan;
      m.makeTranslation(s.x, s.y + 0.8 + lift, s.z);
      bodies.setMatrixAt(i, m);
      m.makeTranslation(s.x, s.y + 1.65 + lift, s.z);
      heads.setMatrixAt(i, m);
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
  };
  return { group: g, update };
}

/** A strip standing on the rink outline (offset ft outside the ice edge), from y0 to y1, with its texture running along the boards. */
function ribbon(offset: number, y0: number, y1: number, mat: THREE.Material, repeatLen: number): THREE.Mesh {
  const outline = roundedRect(W + 2 * offset, H + 2 * offset, CORNER + offset);
  const pts = outline.getSpacedPoints(400);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let run = 0;
  pts.forEach((p, i) => {
    if (i > 0) run += p.distanceTo(pts[i - 1]);
    pos.push(p.x, y0, -p.y, p.x, y1, -p.y);
    // Runs backwards so the text reads the right way from inside the rink.
    uv.push(-run / repeatLen, 0, -run / repeatLen, 1);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

/** Dasher-board panels: the home team and the game's own name, no real sponsors. */
function adsTexture(abbr: [string, string], names: [string, string], colors: Rink3DProps['colors']): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 72;
  const g = c.getContext('2d')!;
  const panels: [string, string, string][] = [
    [colors[0][0], textOn(colors[0][0]), `${names[0].toUpperCase()} HOCKEY`],
    ['#ffffff', colors[0][0], 'HOCKEY GM'],
    [colors[0][1], textOn(colors[0][1]), `GO ${abbr[0]}!`],
    ['#ffffff', '#1b2a44', 'HOCKEY GM'],
    [colors[1][0], textOn(colors[1][0]), `WELCOME ${abbr[1]}`],
    ['#ffffff', colors[0][0], `${abbr[0]} · ${abbr[1]}`],
  ];
  const w = c.width / panels.length;
  panels.forEach(([bg, fg, text], i) => {
    g.fillStyle = bg;
    g.fillRect(i * w, 0, w, 72);
    g.fillStyle = fg;
    g.font = '800 44px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, i * w + w / 2, 38, w - 24);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Broadcast name tag that floats over the puck carrier. */
function nameTag(p: RinkPlayer | undefined, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(8,10,14,0.82)';
  g.fillRect(0, 10, 512, 76);
  g.fillStyle = color;
  g.fillRect(0, 10, 18, 76);
  g.fillStyle = '#ffffff';
  g.font = '800 54px "Barlow Condensed", system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(`${p?.number != null ? `#${p.number} ` : ''}${(p?.last ?? '').toUpperCase()}`, 36, 50, 460);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(11, 2.06, 1);
  s.renderOrder = 10;
  return s;
}

function scoreboardTexture(abbr: [string, string], score: [number, number], colors: Rink3DProps['colors']): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05070b';
  g.fillRect(0, 0, 512, 256);
  for (const [i, x] of [0, 256].entries()) {
    g.fillStyle = colors[i][0];
    g.fillRect(x + 12, 12, 232, 56);
    g.fillStyle = textOn(colors[i][0]);
    g.font = '800 44px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(abbr[i], x + 128, 42);
    g.fillStyle = '#ffd34d';
    g.font = '800 140px "Barlow Condensed", system-ui, sans-serif';
    g.fillText(String(score[i]), x + 128, 170);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export default function Rink3D({ motion, meta, colors, abbr, logo, names, score, period, light, goalTeam, replaying, onFail }: Rink3DProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const [cam, setCam] = useState<Cam3D>(() => {
    try {
      return (localStorage.getItem('hgm.cam3d') as Cam3D) || 'behind';
    } catch {
      return 'behind';
    }
  });
  const live = useRef({ cam, score, period, light, goalTeam, replaying });
  live.current = { cam, score, period, light, goalTeam, replaying };

  useEffect(() => {
    try {
      localStorage.setItem('hgm.cam3d', cam);
    } catch {
      /* per-viewer convenience only */
    }
  }, [cam]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      onFail();
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0d14');
    scene.fog = new THREE.Fog('#0a0d14', 170, 340);
    // Soft studio reflections on helmets, the ice and the glass.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.45;
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, 1, 800);

    // Lights: arena rigs overhead.
    scene.add(new THREE.HemisphereLight('#ffffff', '#3a4a5c', 0.75));
    const sun = new THREE.DirectionalLight('#ffffff', 1.9);
    sun.position.set(-40, 140, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -115;
    sc.right = 115;
    sc.top = 60;
    sc.bottom = -60;
    sc.near = 20;
    sc.far = 320;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.4;
    scene.add(sun);
    const fill = new THREE.DirectionalLight('#dfe8ff', 0.45);
    fill.position.set(60, 90, -70);
    scene.add(fill);

    // Ice: glossy, so the lights and players catch in it.
    const iceTex = iceTexture(abbr[0], colors[0][0]);
    const ice = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshPhysicalMaterial({ map: iceTex, transparent: true, alphaTest: 0.5, roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 }),
    );
    ice.rotation.x = -Math.PI / 2;
    ice.receiveShadow = true;
    scene.add(ice);
    // Repaint with the home logo once it loads; a cross-origin image that taints the canvas keeps the crest.
    let logoImg: HTMLImageElement | null = null;
    if (logo) {
      logoImg = new Image();
      logoImg.crossOrigin = 'anonymous';
      logoImg.onload = () => {
        if (!logoImg) return;
        try {
          const t = iceTexture(abbr[0], colors[0][0], logoImg);
          (t.image as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1);
          const m = ice.material as THREE.MeshPhysicalMaterial;
          m.map?.dispose();
          m.map = t;
          m.needsUpdate = true;
        } catch {
          /* keep the crest */
        }
      };
      logoImg.src = logo;
    }
    // Concourse floor beyond the boards.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 400), new THREE.MeshStandardMaterial({ color: '#10141c', roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    scene.add(floor);
    // Boards: white, a yellow kickplate, a ring of dasher ads facing the ice, a team-coloured cap; glass and its posts above.
    scene.add(band(0, 0.7, 3.4, 0, new THREE.MeshStandardMaterial({ color: '#f3f5f7', roughness: 0.5 })));
    scene.add(band(-0.02, 0.72, 0.7, 0, new THREE.MeshStandardMaterial({ color: '#e8b923', roughness: 0.6 })));
    scene.add(ribbon(-0.04, 0.85, 3.25, new THREE.MeshStandardMaterial({ map: adsTexture(abbr, names, colors), roughness: 0.55, side: THREE.DoubleSide }), 120));
    scene.add(band(-0.05, 0.9, 0.3, 3.4, new THREE.MeshStandardMaterial({ color: colors[0][0], roughness: 0.4 })));
    scene.add(band(0.3, 0.45, 6, 3.7, new THREE.MeshPhysicalMaterial({ color: '#d8ecff', transparent: true, opacity: 0.1, roughness: 0.02, metalness: 0, clearcoat: 1, depthWrite: false })));
    {
      const outline = roundedRect(W + 0.75, H + 0.75, CORNER + 0.375);
      const posts = outline.getSpacedPoints(Math.floor(outline.getLength() / 8));
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 6, 0.22), new THREE.MeshStandardMaterial({ color: '#d9dde2', roughness: 0.4, metalness: 0.6 }), posts.length);
      const m = new THREE.Matrix4();
      posts.forEach((p, i) => im.setMatrixAt(i, m.makeTranslation(p.x, 6.7, -p.y)));
      scene.add(im);
    }
    scene.add(buildNet(RINK.goalL, 1));
    scene.add(buildNet(RINK.goalR, -1));
    const crowd = buildCrowd(colors[0][0], colors[1][0]);
    scene.add(crowd.group);
    // Lighting rig: a ring of bright fixtures over the ice.
    {
      const rig = band(18, 21, 1.2, 74, new THREE.MeshStandardMaterial({ color: '#1a1f27', roughness: 0.8 }));
      scene.add(rig);
      const outline = roundedRect(W + 39, H + 39, CORNER + 19.5);
      const lamps = outline.getSpacedPoints(36);
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.4, 2.4), new THREE.MeshBasicMaterial({ color: '#fffbe8' }), lamps.length);
      const m = new THREE.Matrix4();
      lamps.forEach((p, i) => im.setMatrixAt(i, m.makeTranslation(p.x, 73.6, -p.y)));
      scene.add(im);
    }

    // Hanging scoreboard over centre ice.
    const boardMat = new THREE.MeshBasicMaterial({ map: scoreboardTexture(abbr, live.current.score, colors) });
    const dark = new THREE.MeshStandardMaterial({ color: '#111' });
    const jumbo = new THREE.Mesh(new THREE.BoxGeometry(22, 11, 22), [boardMat, boardMat, dark, dark, boardMat, boardMat]);
    jumbo.position.set(0, 62, 0);
    scene.add(jumbo);
    const halo = new THREE.Mesh(new THREE.CylinderGeometry(15.5, 15.5, 1.2, 40, 1, true), new THREE.MeshBasicMaterial({ color: colors[0][0], side: THREE.DoubleSide }));
    halo.position.set(0, 55.5, 0);
    scene.add(halo);
    let shownScore = live.current.score.join('-');

    // Goal lights behind each net.
    const lamps = [RINK.goalL, RINK.goalR].map((gx) => {
      const l = new THREE.PointLight('#ff2a2a', 0, 45, 1.5);
      const p = toScene(gx, RINK.cy);
      l.position.set(p.x + (gx < RINK.cx ? -6 : 6), 9, 0);
      scene.add(l);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), new THREE.MeshBasicMaterial({ color: '#550000' }));
      bulb.position.copy(l.position);
      scene.add(bulb);
      return { l, bulb, gx };
    });

    // Puck and its trail.
    const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.18, 20), new THREE.MeshStandardMaterial({ color: '#050505', roughness: 0.35 }));
    puck.castShadow = true;
    scene.add(puck);
    const trailGeo = new THREE.BufferGeometry();
    const trailPts = new Float32Array(10 * 3);
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPts, 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0 }));
    scene.add(trail);
    const trailHist: THREE.Vector3[] = [];

    // Ice spray when a skater stops hard.
    const SPRAY = 260;
    const sprayPos = new Float32Array(SPRAY * 3);
    const sprayVel = new Float32Array(SPRAY * 3);
    const sprayLife = new Float32Array(SPRAY);
    let sprayNext = 0;
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
    const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 0.45, transparent: true, opacity: 0.85, depthWrite: false }));
    spray.frustumCulled = false;
    scene.add(spray);
    const emit = (x: number, z: number, vx: number, vz: number) => {
      for (let k = 0; k < 10; k++) {
        const i = sprayNext;
        sprayNext = (sprayNext + 1) % SPRAY;
        sprayPos[i * 3] = x;
        sprayPos[i * 3 + 1] = 0.2;
        sprayPos[i * 3 + 2] = z;
        const side = Math.random() < 0.5 ? -1 : 1;
        sprayVel[i * 3] = vx * 0.5 + -vz * side * 0.4 + (Math.random() - 0.5) * 6;
        sprayVel[i * 3 + 1] = 2 + Math.random() * 4;
        sprayVel[i * 3 + 2] = vz * 0.5 + vx * side * 0.4 + (Math.random() - 0.5) * 6;
        sprayLife[i] = 0.5 + Math.random() * 0.3;
      }
    };

    const skaters = new Map<number, Skater>();
    /** Built players not on the ice right now, kept for their next shift. */
    const benched = new Map<number, Skater>();
    const tags = new Map<number, THREE.Sprite>();
    const makeSkater = (id: number, fallbackTeam: 0 | 1, goalie: boolean): Skater => {
      const m = meta.get(id);
      const team = (m?.team ?? fallbackTeam) as 0 | 1;
      // Home in their colours, visitors in white with their colour as trim (as on TV).
      return buildSkater(m, team, goalie, team === 0 ? colors[0] : ['#f4f4f2', colors[1][0]]);
    };
    const makeTag = (id: number): THREE.Sprite => {
      const m = meta.get(id);
      const tag = nameTag(m, colors[(m?.team ?? 0) as 0 | 1][0]);
      tag.visible = false;
      tags.set(id, tag);
      return tag;
    };
    // Build everyone dressed and compile every shader before play starts: building a player or
    // compiling a new material the first time it shows up stalls the frame mid-play.
    {
      const warm: THREE.Object3D[] = [];
      for (const [id, m] of meta) {
        const s = makeSkater(id, m.team, m.pos === 'G');
        benched.set(id, s);
        warm.push(s.root, makeTag(id));
      }
      for (const o of warm) scene.add(o);
      // compile() covers hidden objects too (the goal light, the trail); one real frame with everyone
      // in view catches the variants that only show up at draw time (shadows, sprites).
      renderer.compile(scene, camera);
      for (const t of tags.values()) {
        t.visible = true;
        t.position.set(0, 11.5, 0);
      }
      camera.position.set(0, 60, 90);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      for (const t of tags.values()) t.visible = false;
      scene.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          const map = (x as THREE.MeshStandardMaterial).map;
          if (map) renderer.initTexture(map);
        }
      });
      for (const s of benched.values()) scene.remove(s.root);
    }
    const gold = new THREE.Color('#f2c94c');
    const teamCol = [new THREE.Color(colors[0][0]), new THREE.Color(colors[1][0])];
    const camPos = new THREE.Vector3(0, 60, 90);
    const camLook = new THREE.Vector3();
    let fov = 42;
    let firstFrame = true;
    let excite = 0;

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    let last = performance.now();
    let prevP = motion.P;
    const prevPuck = new THREE.Vector3();
    const want = new THREE.Vector3();
    const look = new THREE.Vector3();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const L = live.current;
      const t = now / 1000;
      // Players come and go with line changes.
      for (const [id, s] of skaters)
        if (!motion.bodies.has(id)) {
          scene.remove(s.root);
          skaters.delete(id);
          benched.set(id, s);
        }
      const pm = motion.puck.mode;
      const carrier = pm.kind === 'carried' ? pm.carrier : null;
      const goalFor = L.goalTeam ?? L.light;
      for (const [id, b] of motion.bodies) {
        let s = skaters.get(id);
        if (!s) {
          s = benched.get(id);
          if (s && s.goalie === b.goalie) benched.delete(id);
          else s = makeSkater(id, b.team, b.goalie);
          skaters.set(id, s);
          scene.add(s.root);
        }
        const p = toScene(b.pos.x, b.pos.y);
        s.root.position.set(p.x, 0, p.z);
        s.body.rotation.y = -b.face;
        const sp = Math.hypot(b.vel.x, b.vel.y);
        // Celebrating a goal: arms up, a little hop (goalies too, if theirs scored).
        const cheering = goalFor !== null && s.team === goalFor;
        s.cheer += ((cheering ? 1 : 0) - s.cheer) * Math.min(1, dt * 6);
        if (!s.goalie) {
          s.phase += dt * (2 + sp * 0.32);
          const amp = Math.min(0.75, sp / 28) * (1 - s.cheer * 0.7);
          // Strides push out to the side as much as back.
          s.legL.rotation.z = Math.sin(s.phase) * amp;
          s.legR.rotation.z = -Math.sin(s.phase) * amp;
          s.legL.rotation.x = Math.max(0, Math.sin(s.phase)) * amp * 0.45;
          s.legR.rotation.x = -Math.max(0, -Math.sin(s.phase)) * amp * 0.45;
          s.body.rotation.z = -Math.min(0.32, sp / 70) * (1 - s.cheer);
          s.body.position.y = Math.abs(Math.sin(s.phase)) * amp * 0.12 + s.cheer * Math.abs(Math.sin(t * 6 + id)) * 0.9;
          // Arms swing with the stride; up in the air for a goal.
          const swing = Math.sin(s.phase) * amp * 0.35;
          s.armL.rotation.z = THREE.MathUtils.lerp(0.55 + swing, 2.7, s.cheer);
          s.armR.rotation.z = THREE.MathUtils.lerp(0.55 - swing * 0.3, 2.5, s.cheer);
          s.armL.rotation.x = -0.35 * s.cheer;
          s.armR.rotation.x = 0.35 * s.cheer;
          // Hard stop: a spray of snow off the blades.
          const decel = (s.lastSp - sp) / Math.max(dt, 1e-3);
          if (s.lastSp > 11 && decel > 30 && Math.random() < 0.6) emit(p.x, p.z, b.vel.x, b.vel.y);
        } else {
          // Butterfly when a shot is on its way.
          const down = pm.kind === 'flying' && pm.shot && Math.hypot(pm.to.x - b.pos.x, pm.to.y - b.pos.y) < 9;
          const target = down ? 0.65 : 1;
          s.body.scale.y += (target * SCALE - s.body.scale.y) * Math.min(1, dt * 12);
          s.armL.rotation.z = THREE.MathUtils.lerp(0.35, 2.6, s.cheer);
          s.armR.rotation.z = THREE.MathUtils.lerp(0.35, 2.4, s.cheer);
        }
        s.lastSp = sp;
        const has = id === carrier;
        const rm = s.ring.material as THREE.MeshBasicMaterial;
        rm.color.copy(has ? gold : teamCol[s.team]);
        const pulse = has ? 1 + Math.sin(t * 7) * 0.08 : 1;
        s.ring.scale.setScalar(pulse * (has ? 1.12 : 1));
        const r2 = s.ring2.material as THREE.MeshBasicMaterial;
        r2.color.copy(has ? gold : teamCol[s.team]);
        r2.opacity = has ? 0.75 : 0.35;
      }

      // Name tag over the puck carrier.
      for (const [id, tag] of tags) tag.visible = id === carrier && !L.replaying;
      if (carrier !== null && skaters.has(carrier)) {
        let tag = tags.get(carrier);
        if (!tag) {
          tag = makeTag(carrier);
          scene.add(tag);
        }
        const r = skaters.get(carrier)!.root.position;
        tag.position.set(r.x, 11.5, r.z);
        tag.visible = !L.replaying;
      }

      // Spray particles: fly, fall and fade.
      for (let i = 0; i < SPRAY; i++) {
        if (sprayLife[i] <= 0) {
          sprayPos[i * 3 + 1] = -5;
          continue;
        }
        sprayLife[i] -= dt;
        sprayVel[i * 3 + 1] -= 18 * dt;
        sprayPos[i * 3] += sprayVel[i * 3] * dt;
        sprayPos[i * 3 + 1] = Math.max(0.05, sprayPos[i * 3 + 1] + sprayVel[i * 3 + 1] * dt);
        sprayPos[i * 3 + 2] += sprayVel[i * 3 + 2] * dt;
      }
      sprayGeo.attributes.position.needsUpdate = true;

      // Puck: on the ice, lifted on shots.
      const pk = motion.puck.pos;
      const pp = toScene(pk.x, pk.y);
      let py = 0.12;
      const shotFlying = pm.kind === 'flying' && !!pm.shot;
      if (pm.kind === 'flying' && pm.shot) {
        const f = Math.min(1, Math.max(0, (motion.P - pm.t0) / Math.max(0.05, pm.t1 - pm.t0)));
        py += Math.sin(Math.PI * f) * 2.2;
      }
      puck.position.set(pp.x, py, pp.z);
      const dP = motion.P - prevP;
      prevP = motion.P;
      const speed = dP > 0 ? puck.position.distanceTo(prevPuck) / dP : 0;
      prevPuck.copy(puck.position);
      if (speed > 40 && pm.kind !== 'carried') trailHist.push(puck.position.clone());
      else trailHist.splice(0, Math.max(1, Math.ceil(trailHist.length / 3)));
      if (trailHist.length > 10) trailHist.splice(0, trailHist.length - 10);
      for (let i = 0; i < 10; i++) {
        const v = trailHist[Math.min(i, trailHist.length - 1)] ?? puck.position;
        trailPts[i * 3] = v.x;
        trailPts[i * 3 + 1] = v.y;
        trailPts[i * 3 + 2] = v.z;
      }
      trailGeo.attributes.position.needsUpdate = true;
      (trail.material as THREE.LineBasicMaterial).opacity = trailHist.length > 1 ? 0.7 : 0;

      // Goal lights; the crowd gets up for goals and leans in on shots.
      let litNet: (typeof lamps)[number] | null = null;
      for (const lp of lamps) {
        const beaten = goalFor !== null && (attackDir(goalFor, L.period) > 0 ? lp.gx > RINK.cx : lp.gx < RINK.cx);
        if (beaten) litNet = lp;
        const on = beaten && L.light !== null;
        const k = on ? 0.6 + 0.4 * Math.abs(Math.sin(t * 7)) : 0;
        lp.l.intensity = k * 900;
        (lp.bulb.material as THREE.MeshBasicMaterial).color.set(on ? '#ff3030' : '#550000');
      }
      const wantExcite = goalFor !== null ? (goalFor === 0 ? 1 : 0.55) : shotFlying ? 0.25 : 0;
      excite += (wantExcite - excite) * Math.min(1, dt * (wantExcite > excite ? 4 : 0.8));
      crowd.update(t, excite);
      const sk = L.score.join('-');
      if (sk !== shownScore) {
        shownScore = sk;
        boardMat.map?.dispose();
        boardMat.map = scoreboardTexture(abbr, L.score, colors);
        boardMat.needsUpdate = true;
      }

      // Camera: follows the puck, smoothed so it glides rather than jerks.
      const fx = THREE.MathUtils.clamp(pp.x, -78, 78);
      const fz = THREE.MathUtils.clamp(pp.z, -30, 30);
      let wantFov = 42;
      let rate = 2.2;
      if (L.replaying) {
        // Replay: a low camera on the glass beside the net the puck is heading for.
        const nx = pp.x >= 0 ? 1 : -1;
        want.set(nx * 72, 9, 40);
        look.set(pp.x, 1.5, pp.z);
        wantFov = 38;
        rate = 3;
      } else if (litNet) {
        // Goal: push in on the net that was just beaten.
        const gp = toScene(litNet.gx, RINK.cy);
        const d = litNet.gx > RINK.cx ? 1 : -1;
        want.set(gp.x - d * 30, 16, 26);
        look.set(gp.x - d * 6, 2, 0);
        wantFov = 36;
        rate = 1.6;
      } else if (L.cam === 'broadcast') {
        want.set(fx, 60, 42.5 + 56);
        look.set(fx, 0, fz * 0.4 - 4);
        if (shotFlying) wantFov = 37;
      } else {
        // Behind the home team, looking the way it attacks this period (like a football end-zone camera).
        const d = attackDir(0, L.period);
        const bx = THREE.MathUtils.clamp(pp.x, -70, 70);
        // Narrow screens (phones) need the camera further back to fit the play.
        const back = camera.aspect < 1.5 ? 1.3 : 1;
        want.set(bx - d * 42 * back, 24 * back, fz * 0.6);
        look.set(bx + d * 10, 0, fz * 0.85);
        if (shotFlying) wantFov = 38;
      }
      const k = firstFrame ? 1 : 1 - Math.exp(-dt * rate);
      firstFrame = false;
      camPos.lerp(want, k);
      camLook.lerp(look, k);
      fov += (wantFov - fov) * Math.min(1, dt * 2.5);
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      if (logoImg) logoImg.onload = null;
      logoImg = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const b of benched.values()) scene.add(b.root);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          (x as THREE.MeshStandardMaterial).map?.dispose();
          x.dispose();
        }
      });
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
    // The scene is built once per game; live values come through `live`.
  }, [motion, meta, colors, abbr, logo, names, onFail]);

  return (
    <div className="rink3d" ref={host}>
      <div className="rink3d-cams">
        <button className={`rink-toggle ${cam === 'behind' ? 'on' : ''}`} onClick={() => setCam('behind')} title="Camera behind the play, looking down the ice">
          Behind
        </button>
        <button className={`rink-toggle ${cam === 'broadcast' ? 'on' : ''}`} onClick={() => setCam('broadcast')} title="TV camera from the side">
          Broadcast
        </button>
      </div>
    </div>
  );
}
