const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const formatters = new Map();

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function clockMinutes(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw invalid('服务时间请使用 00:00 至 23:59 的 HH:mm 格式。');
  }
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && dateKey(date) === value;
}

/** Validate before saving settings. Empty days explicitly means no schedule is set. */
export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw invalid('人工服务时间配置无效。');
  }
  const { timezone, days, start, end, holidays = [] } = schedule;
  if (typeof timezone !== 'string' || timezone.length > 100) throw invalid('服务时区无效。');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date());
  } catch {
    throw invalid('服务时区无效，请填写有效时区，例如 Asia/Hong_Kong。');
  }
  if (!Array.isArray(days) || days.length > 7 || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw invalid('服务星期必须为 0 至 6 的整数，0 表示周日。');
  }
  if (clockMinutes(start) === clockMinutes(end)) {
    throw invalid('服务开始与结束时间不能相同；跨夜时段请填写不同的时间。');
  }
  if (!Array.isArray(holidays) || holidays.length > 3660 || holidays.some(day => !validDate(day))) {
    throw invalid('休息日必须为有效的 YYYY-MM-DD 日期，最多 3660 个。');
  }
  return { timezone, days: [...new Set(days)].sort((a, b) => a - b), start, end, holidays: [...new Set(holidays)].sort() };
}

function formatter(timezone) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(timezone, value);
  }
  return value;
}

function localParts(epoch, timezone) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(epoch)).map(part => [part.type, part.value]));
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return { key, minute, second: Number(parts.second), day: new Date(`${key}T00:00:00Z`).getUTCDay() };
}

function localEpoch(parts) {
  return new Date(`${parts.key}T00:00:00Z`).getTime() + parts.minute * MINUTE_MS + parts.second * 1000;
}

function isOpenAt(schedule, epoch, holidays) {
  const local = localParts(epoch, schedule.timezone);
  if (holidays.has(local.key)) return false; // A rest date closes that entire local calendar day.
  const start = clockMinutes(schedule.start);
  const end = clockMinutes(schedule.end);
  if (start < end) return schedule.days.includes(local.day) && local.minute >= start && local.minute < end;
  if (local.minute >= start) return schedule.days.includes(local.day);
  if (local.minute >= end) return false;
  const prior = dateKey(new Date(new Date(`${local.key}T00:00:00Z`).getTime() - DAY_MS));
  return schedule.days.includes((local.day + 6) % 7) && !holidays.has(prior);
}

/** A repeated DST wall-clock start can have two real instants. Missing times are handled below. */
function openingInstants(key, minute, timezone) {
  const target = new Date(`${key}T00:00:00Z`).getTime() + minute * MINUTE_MS;
  const offsets = new Set();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = target + hours * 3_600_000;
    offsets.add(localEpoch(localParts(sample, timezone)) - sample);
  }
  const estimates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
  const exact = estimates.filter(epoch => {
    const local = localParts(epoch, timezone);
    return local.key === key && local.minute === minute;
  });
  if (exact.length) return exact;
  // Spring-forward can erase the requested start. Find the first actual minute after it.
  for (let epoch = estimates[0]; epoch <= estimates.at(-1); epoch += MINUTE_MS) {
    const local = localParts(epoch, timezone);
    if (local.key === key && local.minute >= minute) return [epoch];
  }
  return [];
}

export function serviceStatus(schedule, now = new Date()) {
  if (!schedule) return { isOpen: false, nextOpen: null, label: '人工服务时间尚未设置' };
  const config = validateSchedule(schedule);
  const epoch = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(epoch)) throw invalid('用于计算服务时间的日期无效。');
  if (!config.days.length) return { isOpen: false, nextOpen: null, label: '人工服务时间尚未设置' };
  const holidays = new Set(config.holidays);
  const start = clockMinutes(config.start);
  const end = clockMinutes(config.end);
  const label = `${[...config.days].sort((a, b) => (a || 7) - (b || 7)).map(day => DAY_NAMES[day]).join('、')} ${config.start}–${start > end ? '次日 ' : ''}${config.end}（${config.timezone}${holidays.size ? '，休息日除外' : ''}）`;
  if (isOpenAt(config, epoch, holidays)) return { isOpen: true, nextOpen: null, label };
  const today = localParts(epoch, config.timezone).key;
  const firstDate = new Date(`${today}T00:00:00Z`).getTime();
  // With N isolated rest dates, N+1 weeks guarantee at least one uncancelled weekly shift.
  const horizon = (holidays.size + 2) * 7;
  for (let offset = 0; offset <= horizon; offset++) {
    const day = new Date(firstDate + offset * DAY_MS);
    const key = dateKey(day);
    if (!config.days.includes(day.getUTCDay()) || holidays.has(key)) continue;
    for (const candidate of openingInstants(key, start, config.timezone)) {
      if (candidate > epoch && isOpenAt(config, candidate, holidays)) {
        return { isOpen: false, nextOpen: new Date(candidate).toISOString(), label };
      }
    }
  }
  return { isOpen: false, nextOpen: null, label };
}
