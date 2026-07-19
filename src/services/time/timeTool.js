/**
 * ZAO - Time Tool
 *
 * Resolves "what time is it in X" to a real IANA timezone and the
 * current wall-clock time in it - the data source behind ClockWidget.js
 * and the time_get_current tool (src/services/toolOrchestrator.js).
 *
 * NO BACKEND CALL, unlike most other tools in this repo: the JS engine's
 * own Intl implementation already ships the full IANA timezone database
 * (that's what powers Intl.DateTimeFormat's { timeZone } option), so
 * there's nothing to fetch - this runs entirely on-device, instantly,
 * even with no PC backend connection at all.
 *
 * CITY_ALIASES exists because the model (and the person) will often say
 * "Tokyo" or "New York," not the IANA identifier "Asia/Tokyo" /
 * "America/New_York" Intl actually requires - this is a small,
 * deliberately non-exhaustive lookup for common cities/countries, not a
 * reimplementation of the tz database. Anything not in it is passed to
 * Intl as-is, so a person (or the model) giving the real IANA name
 * directly always still works.
 */

const CITY_ALIASES = {
  'tokyo': 'Asia/Tokyo', 'japan': 'Asia/Tokyo',
  'new york': 'America/New_York', 'nyc': 'America/New_York', 'eastern time': 'America/New_York', 'est': 'America/New_York', 'edt': 'America/New_York',
  'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles', 'pacific time': 'America/Los_Angeles', 'pst': 'America/Los_Angeles', 'pdt': 'America/Los_Angeles',
  'chicago': 'America/Chicago', 'central time': 'America/Chicago',
  'denver': 'America/Denver', 'mountain time': 'America/Denver',
  'london': 'Europe/London', 'uk': 'Europe/London', 'england': 'Europe/London', 'bst': 'Europe/London', 'gmt': 'UTC', 'utc': 'UTC',
  'paris': 'Europe/Paris', 'france': 'Europe/Paris',
  'berlin': 'Europe/Berlin', 'germany': 'Europe/Berlin',
  'madrid': 'Europe/Madrid', 'spain': 'Europe/Madrid',
  'rome': 'Europe/Rome', 'italy': 'Europe/Rome',
  'moscow': 'Europe/Moscow', 'russia': 'Europe/Moscow',
  'dubai': 'Asia/Dubai', 'uae': 'Asia/Dubai',
  'india': 'Asia/Kolkata', 'mumbai': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata', 'ist': 'Asia/Kolkata',
  'china': 'Asia/Shanghai', 'beijing': 'Asia/Shanghai', 'shanghai': 'Asia/Shanghai',
  'hong kong': 'Asia/Hong_Kong',
  'singapore': 'Asia/Singapore',
  'seoul': 'Asia/Seoul', 'korea': 'Asia/Seoul', 'south korea': 'Asia/Seoul',
  'bangkok': 'Asia/Bangkok', 'thailand': 'Asia/Bangkok',
  'jakarta': 'Asia/Jakarta', 'indonesia': 'Asia/Jakarta',
  'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne', 'australia': 'Australia/Sydney',
  'auckland': 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland',
  'toronto': 'America/Toronto', 'canada': 'America/Toronto', 'vancouver': 'America/Vancouver',
  'mexico city': 'America/Mexico_City', 'mexico': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo', 'brazil': 'America/Sao_Paulo',
  'cairo': 'Africa/Cairo', 'egypt': 'Africa/Cairo',
  'lagos': 'Africa/Lagos', 'nigeria': 'Africa/Lagos',
  'johannesburg': 'Africa/Johannesburg', 'south africa': 'Africa/Johannesburg',
  'istanbul': 'Europe/Istanbul', 'turkey': 'Europe/Istanbul',
  'karachi': 'Asia/Karachi', 'pakistan': 'Asia/Karachi',
};

/** Resolves a person/model-supplied place name to a real IANA timezone identifier Intl will accept, or null for "device local time." */
function resolveTimezone(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || /^local$/i.test(trimmed)) return null;

  const alias = CITY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  return trimmed; // assume it's already a real IANA identifier (e.g. "Europe/Lisbon")
}

/**
 * @param {string|null} [timezoneInput] - a city/country name, an IANA identifier, or null/omitted for local time
 * @returns {{success: boolean, data: {timezone: string|null, resolvedLabel: string, formatted: string, zoneName: string, isoInZone: string}|null, error: object|null}}
 */
export function getCurrentTime(timezoneInput = null) {
  const timezone = resolveTimezone(timezoneInput);

  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      hour12: true,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const zoneNameFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, timeZoneName: 'long' });

    const formatted = formatter.format(now);
    const zoneName = zoneNameFormatter.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || timezone || 'device local time';

    return {
      success: true,
      data: {
        timezone, // null means "device local" - ClockWidget reads this directly
        resolvedLabel: timezoneInput || 'your local time',
        formatted,
        zoneName,
      },
      error: null,
    };
  } catch (err) {
    // Intl throws RangeError for a string it can't resolve as a timezone
    // (a typo, or a genuinely made-up name) - surfaced as a clear error
    // rather than silently falling back to local time, so the model
    // knows to ask for clarification instead of showing the wrong clock.
    return {
      success: false,
      data: null,
      error: { message: `"${timezoneInput}" isn't a recognized timezone or city. Try a major city name or an IANA timezone like "Europe/Lisbon".` },
    };
  }
}
