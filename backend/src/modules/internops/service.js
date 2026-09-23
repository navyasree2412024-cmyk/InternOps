const fs = require('fs');
const path = require('path');

// Simple CSV helper to handle quoted values with commas
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result.map((val) => val.replace(/^"|"$/g, '').trim());
}

// Convert HH:MM:SS or HH:MM string to total whole integer seconds past midnight
function parseTimeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr
    .trim()
    .split(':')
    .map((p) => parseInt(p, 10) || 0);
  const hours = parts[0] || 0;
  const minutes = parts[1] || 0;
  const seconds = parts[2] || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

// Convert HH:MM:SS or HH:MM string to total whole integer minutes past midnight
function parseTimeToMinutes(timeStr) {
  return Math.floor(parseTimeToSeconds(timeStr) / 60);
}

// Standard scheduled workday parameters
const STANDARD_END_SECONDS = 17 * 3600; // 17:00:00 = 61200 seconds
const STANDARD_DAY_MINUTES = 8 * 60; // 480 minutes
const STANDARD_DAY_SECONDS = 8 * 3600; // 28800 seconds
const HALF_DAY_MINUTES = 4 * 60; // 240 minutes
const HALF_DAY_SECONDS = 4 * 3600; // 14400 seconds

// Compute attendance duration in exact integer minutes and seconds
function calculateAttendanceDuration(record) {
  const status = (record.status || '').toUpperCase();
  if (status === 'ABSENT') {
    return { minutes: 0, seconds: 0 };
  }

  // If explicit duration or departure time is provided
  if (record.rawDurationOrDeparture) {
    const raw = String(record.rawDurationOrDeparture).trim();
    if (raw.includes(':')) {
      const arrivalSec = parseTimeToSeconds(record.arrivalTime);
      const departureSec = parseTimeToSeconds(raw);
      const durationSec = Math.max(0, departureSec - arrivalSec);
      return {
        minutes: Math.floor(durationSec / 60),
        seconds: durationSec,
      };
    } else if (!isNaN(parseFloat(raw))) {
      const hoursNum = parseFloat(raw);
      const minutes = Math.round(hoursNum * 60);
      return { minutes, seconds: minutes * 60 };
    }
  }

  if (status === 'HALF_DAY') {
    return { minutes: HALF_DAY_MINUTES, seconds: HALF_DAY_SECONDS };
  }

  if (status === 'PRESENT') {
    if (record.arrivalTime) {
      const arrivalSec = parseTimeToSeconds(record.arrivalTime);
      const durationSec = Math.max(0, STANDARD_END_SECONDS - arrivalSec);
      return {
        minutes: Math.floor(durationSec / 60),
        seconds: durationSec,
      };
    }
    return { minutes: STANDARD_DAY_MINUTES, seconds: STANDARD_DAY_SECONDS };
  }

  return { minutes: 0, seconds: 0 };
}

function getSummary(startDate, endDate) {
  const attendanceFilePath = path.resolve(
    __dirname,
    '../../../../attendance.csv'
  );
  const ratingsFilePath = path.resolve(__dirname, '../../../../ratings.csv');

  let attendanceRecords = [];
  try {
    const attendanceData = fs.readFileSync(attendanceFilePath, 'utf8');
    const lines = attendanceData.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCSVLine(line);
      if (cols.length < 4) continue;
      const rawDurationOrDeparture = cols[5] || null;
      const attRecord = {
        email: cols[0],
        name: cols[1],
        date: cols[2],
        status: cols[3],
        arrivalTime: cols[4] || null,
        rawDurationOrDeparture,
      };
      const duration = calculateAttendanceDuration(attRecord);
      attendanceRecords.push({
        ...attRecord,
        workingMinutes: duration.minutes,
        workingSeconds: duration.seconds,
      });
    }
  } catch (err) {
    console.error('Error reading attendance.csv:', err);
  }

  let ratingsRecords = [];
  try {
    const ratingsData = fs.readFileSync(ratingsFilePath, 'utf8');
    const lines = ratingsData.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCSVLine(line);
      if (cols.length < 4) continue;
      const parsedScore = parseFloat(cols[3]);
      // Store rating scores in integer hundredths (cents/basis points) to eliminate float drift
      const scoreHundredths = Math.round(parsedScore * 100);
      ratingsRecords.push({
        email: cols[0],
        name: cols[1],
        date: cols[2],
        score: parsedScore,
        scoreHundredths,
        remarks: cols[4] || '',
      });
    }
  } catch (err) {
    console.error('Error reading ratings.csv:', err);
  }

  // Deduplicate interns using their email
  const internsMap = new Map();
  for (const record of [...attendanceRecords, ...ratingsRecords]) {
    if (record.email && !internsMap.has(record.email)) {
      internsMap.set(record.email, {
        id: record.email,
        name: record.name,
        email: record.email,
      });
    }
  }

  const result = [];

  for (const intern of internsMap.values()) {
    // Filter attendance in range (inclusive)
    const atts = attendanceRecords
      .filter(
        (r) =>
          r.email === intern.email && r.date >= startDate && r.date <= endDate
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    // Filter ratings in range (inclusive)
    const rats = ratingsRecords
      .filter(
        (r) =>
          r.email === intern.email && r.date >= startDate && r.date <= endDate
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalAttendance = atts.length;
    const presentDays = atts.filter(
      (r) => r.status.toUpperCase() === 'PRESENT'
    ).length;
    const attendancePercentage =
      totalAttendance === 0
        ? 100
        : Math.round((presentDays / totalAttendance) * 100);

    // Sum time parameters strictly as whole integers to prevent floating-point rounding drift
    let totalWorkingMinutes = 0;
    let totalWorkingSeconds = 0;
    for (const a of atts) {
      totalWorkingMinutes += a.workingMinutes;
      totalWorkingSeconds += a.workingSeconds;
    }

    // Sum rating points as scaled whole integers (scoreHundredths)
    const numRatings = rats.length;
    const totalRatingPoints = rats.reduce(
      (sum, r) => sum + r.scoreHundredths,
      0
    );
    const avgRating =
      numRatings === 0
        ? 0
        : Number((totalRatingPoints / (numRatings * 100)).toFixed(2));
    const latestRating = numRatings > 0 ? rats[rats.length - 1].score : 0;

    let ratingTrend = 'INSUFFICIENT';
    if (numRatings >= 2) {
      const latest = rats[rats.length - 1].score;
      const prev = rats[rats.length - 2].score;
      if (latest > prev) {
        ratingTrend = 'UP';
      } else if (latest < prev) {
        ratingTrend = 'DOWN';
      } else {
        ratingTrend = 'STABLE';
      }
    }

    let status = 'Good';
    if (numRatings === 0) {
      status = 'Missing Data';
    } else if (avgRating < 4.0 || attendancePercentage < 80) {
      status = 'Attention Required';
    }

    result.push({
      ...intern,
      totalAttendance,
      presentDays,
      attendancePercentage,
      totalWorkingMinutes, // whole integer
      totalWorkingSeconds, // whole integer
      totalRatingPoints, // whole integer scaled by 100
      numRatings,
      avgRating,
      latestRating,
      ratingTrend,
      status,
      ratingsHistory: rats.map((r) => ({
        date: r.date,
        score: r.score,
        remarks: r.remarks,
      })),
      attendanceHistory: atts.map((a) => ({
        date: a.date,
        status: a.status,
        arrivalTime: a.arrivalTime,
        workingMinutes: a.workingMinutes,
        workingSeconds: a.workingSeconds,
      })),
    });
  }

  return result;
}

module.exports = {
  getSummary,
  parseTimeToMinutes,
  parseTimeToSeconds,
  calculateAttendanceDuration,
};
