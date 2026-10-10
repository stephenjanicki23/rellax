import { useEffect, useState } from 'react';
import { sfx } from './sfx';

/** Speaker button and volume for the arena sound (the choice is remembered). */
export function SoundToggle() {
  const [, bump] = useState(0);
  useEffect(() => sfx.subscribe(() => bump((x) => x + 1)), []);
  const { on, volume } = sfx.prefs;
  return (
    <span className="sound-toggle">
      <button
        className={`rink-toggle ${on ? 'on' : ''}`}
        title={on ? 'Arena sound on: goal horn, whistles, crowd. Click to mute.' : 'Arena sound off. Click to turn it on.'}
        aria-pressed={on}
        onClick={() => {
          sfx.set({ on: !on });
          if (!on) sfx.unlock();
        }}
      >
        {on ? '🔊' : '🔇'} Sound
      </button>
      {on && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          aria-label="Volume"
          title={`Volume ${Math.round(volume * 100)}%`}
          onChange={(e) => {
            sfx.set({ volume: Number(e.target.value) });
            sfx.unlock();
          }}
        />
      )}
    </span>
  );
}
