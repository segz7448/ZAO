/**
 * ZAO - Clock Widget
 *
 * A live, second-by-second digital (HH:MM:SS) + analog clock for a given
 * IANA timezone (e.g. "Asia/Tokyo") or the device's own local time.
 * Rendered inline under an assistant reply whenever the model resolves a
 * time_get_current tool call (see src/services/toolOrchestrator.js /
 * src/services/time/timeTool.js) - this is what the person sees instead
 * of just a text sentence when they ask "what time is it in Tokyo?".
 *
 * WHY NO react-native-svg: this repo has no SVG dependency yet, and
 * adding one means a new native module + `expo prebuild`/rebuild before
 * it'd actually run. The analog face below is built entirely from plain
 * RN Views instead - a circular border for the rim, tick marks, and
 * hands - using the standard trick for rotating a hand around a face's
 * center in RN without SVG: each hand sits inside a wrapper the exact
 * size of the face, positioned absolute over it; RN transforms rotate
 * around an element's own center by default, so rotating that
 * full-size wrapper rotates the hand around the face's center, not the
 * hand's own corner.
 *
 * WHY Intl.DateTimeFormat, not manual UTC-offset math: a timezone's
 * offset isn't a fixed number (DST, and offsets that aren't whole
 * hours) - formatToParts() with a { timeZone } option asks the JS
 * engine's own ICU data for the correct wall-clock time in that zone
 * right now, which is the only reliably correct way to do this.
 * REQUIRES full ICU / Intl support in the JS engine (Hermes ships this
 * by default on current Expo SDKs) - if a timezone-specific clock ever
 * shows the device's own time instead of the requested one, that's the
 * symptom to check for first.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

const FACE_SIZE = 128;
const CENTER = FACE_SIZE / 2;

/** Reads the wall-clock h/m/s/date for `timezone` (or device local time if null) out of `now`, via Intl - not manual offset arithmetic (see file header). */
function readTimeParts(now, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || undefined,
    hour12: false,
    year: 'numeric', month: 'short', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    parts[part.type] = part.value;
  }

  // Midnight comes back as hour "24" with hour12: false in some ICU
  // implementations - normalize so the analog hand math (which expects
  // 0-23) doesn't draw a nonsense angle for exactly midnight.
  const hour = Number(parts.hour) % 24;

  return {
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    dateLabel: `${parts.weekday}, ${parts.month} ${parts.day}`,
  };
}

/** Short zone label ("JST", "GMT+9") shown under the digital time, via Intl rather than a hardcoded abbreviation table (which goes stale/wrong across DST). */
function readZoneLabel(now, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, timeZoneName: 'short' });
    const part = formatter.formatToParts(now).find((p) => p.type === 'timeZoneName');
    return part?.value || timezone || 'Local time';
  } catch {
    return timezone || 'Local time';
  }
}

function Hand({ angleDeg, length, width, color }) {
  return (
    <View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${angleDeg}deg` }] }]} pointerEvents="none">
      <View
        style={{
          position: 'absolute',
          left: CENTER - width / 2,
          top: CENTER - length,
          width,
          height: length,
          borderRadius: width / 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function TickMarks({ color }) {
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    const isHour = true;
    ticks.push(
      <View
        key={i}
        style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${i * 30}deg` }] }]}
        pointerEvents="none"
      >
        <View
          style={{
            position: 'absolute',
            left: CENTER - 1,
            top: 6,
            width: 2,
            height: isHour ? 8 : 4,
            backgroundColor: color,
            opacity: 0.6,
          }}
        />
      </View>
    );
  }
  return ticks;
}

function AnalogFace({ hour, minute, second, theme }) {
  const hourAngle = ((hour % 12) + minute / 60) * 30;
  const minuteAngle = (minute + second / 60) * 6;
  const secondAngle = second * 6;

  return (
    <View
      style={{
        width: FACE_SIZE,
        height: FACE_SIZE,
        borderRadius: FACE_SIZE / 2,
        borderWidth: 2,
        borderColor: theme.borderStrong,
        backgroundColor: theme.surface,
      }}
    >
      <TickMarks color={theme.textTertiary} />
      <Hand angleDeg={hourAngle} length={CENTER - 34} width={4} color={theme.textPrimary} />
      <Hand angleDeg={minuteAngle} length={CENTER - 20} width={3} color={theme.textPrimary} />
      <Hand angleDeg={secondAngle} length={CENTER - 16} width={1.5} color={theme.brand} />
      {/* Center pin, drawn last so it sits on top of all three hands. */}
      <View
        style={{
          position: 'absolute',
          left: CENTER - 4,
          top: CENTER - 4,
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.brand,
        }}
      />
    </View>
  );
}

/**
 * @param {object} props
 * @param {string|null} [props.timezone] - IANA name e.g. "Asia/Tokyo", or null/omitted for the device's own local time
 * @param {string} [props.label] - optional display label overriding the timezone name (e.g. "Tokyo")
 * @param {object} props.theme - from useTheme()
 */
export default function ClockWidget({ timezone = null, label = null, theme }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const { hour, minute, second, dateLabel } = useMemo(() => readTimeParts(now, timezone), [now, timezone]);
  const zoneLabel = useMemo(() => readZoneLabel(now, timezone), [now, timezone]);

  const digital = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

  return (
    <View style={[styles.container, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
      <AnalogFace hour={hour} minute={minute} second={second} theme={theme} />
      <View style={styles.digitalColumn}>
        <Text style={[styles.locationLabel, { color: theme.textSecondary }]} numberOfLines={1}>
          {label || timezone || 'Local time'}
        </Text>
        <Text style={[styles.digitalTime, { color: theme.textPrimary }]}>{digital}</Text>
        <Text style={[styles.zoneLabel, { color: theme.textTertiary }]}>{zoneLabel} · {dateLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 6,
    alignSelf: 'flex-start',
    maxWidth: '92%',
  },
  digitalColumn: {
    justifyContent: 'center',
  },
  locationLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  digitalTime: {
    fontSize: 24,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  zoneLabel: {
    fontSize: 11,
    marginTop: 2,
  },
});
