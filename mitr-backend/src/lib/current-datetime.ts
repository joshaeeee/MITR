export const AGENT_TIMEZONE = 'Asia/Kolkata';
export const AGENT_UTC_OFFSET = '+05:30';

export interface CurrentDateTimeContext {
  timezone: string;
  offset: string;
  dateISO: string;
  timeISO: string;
  dateTimeISO: string;
  weekday: string;
  humanReadable: string;
}

const getPart = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string =>
  parts.find((part) => part.type === type)?.value ?? '';

export const getCurrentDateTimeContext = (now = new Date()): CurrentDateTimeContext => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AGENT_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(now);

  const year = getPart(parts, 'year');
  const month = getPart(parts, 'month');
  const monthNumeric = new Intl.DateTimeFormat('en-CA', {
    timeZone: AGENT_TIMEZONE,
    month: '2-digit'
  }).format(now);
  const day = getPart(parts, 'day');
  const hour = getPart(parts, 'hour');
  const minute = getPart(parts, 'minute');
  const second = getPart(parts, 'second');
  const weekday = getPart(parts, 'weekday');

  const dateISO = `${year}-${monthNumeric}-${day}`;
  const timeISO = `${hour}:${minute}:${second}`;

  return {
    timezone: AGENT_TIMEZONE,
    offset: AGENT_UTC_OFFSET,
    dateISO,
    timeISO,
    dateTimeISO: `${dateISO}T${timeISO}${AGENT_UTC_OFFSET}`,
    weekday,
    humanReadable: `${weekday}, ${day} ${month} ${year}, ${hour}:${minute}:${second} IST`
  };
};
