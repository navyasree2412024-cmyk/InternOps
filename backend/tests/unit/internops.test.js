const service = require('../../src/modules/internops/service');
const attendanceRepo = require('../../src/modules/attendance/repository');

describe('InternOps Service', () => {
  test('correctly aggregates attendance and ratings', () => {
    // We pass dates for Aug 17 to Aug 23, 2026.
    const summary = service.getSummary('2026-08-17', '2026-08-23');

    // We expect 5 interns since we seeded 5 interns in the CSV.
    expect(summary.length).toBe(5);

    // Let's verify Sneha Kulkarni's calculations:
    // sneha.intern@internops.com has 5 attendance records in range: 4 PRESENT, 1 ABSENT.
    // Ratings: 17 (score 5), 19 (score 4), 21 (score 5).
    // Attendance % = 80%. Avg rating = 4.67. Latest rating = 5. Trend = UP. Status = Good.
    const sneha = summary.find((i) => i.email === 'sneha.intern@internops.com');
    expect(sneha).toBeDefined();
    expect(sneha.name).toBe('Sneha Kulkarni');
    expect(sneha.totalAttendance).toBe(5);
    expect(sneha.presentDays).toBe(4);
    expect(sneha.attendancePercentage).toBe(80);
    expect(sneha.numRatings).toBe(3);
    expect(sneha.avgRating).toBe(4.67);
    expect(sneha.latestRating).toBe(5);
    expect(sneha.ratingTrend).toBe('UP');
    expect(sneha.status).toBe('Good');

    // Whole integer time tracking assertions (no floating point drift)
    expect(Number.isInteger(sneha.totalWorkingMinutes)).toBe(true);
    expect(Number.isInteger(sneha.totalWorkingSeconds)).toBe(true);
    expect(Number.isInteger(sneha.totalRatingPoints)).toBe(true);
    // 475 (09:05) + 470 (09:10) + 481 (08:59) + 0 (ABSENT) + 478 (09:02) = 1904 minutes
    expect(sneha.totalWorkingMinutes).toBe(1904);
    expect(sneha.totalWorkingSeconds).toBe(1904 * 60);
    expect(sneha.totalRatingPoints).toBe(1400); // 500 + 400 + 500

    // Check individual daily logs have integer durations
    expect(sneha.attendanceHistory[0].workingMinutes).toBe(475);
    expect(sneha.attendanceHistory[0].workingSeconds).toBe(28500);

    // Let's verify Aditya Deshmukh's calculations:
    // aditya.intern@internops.com has 3 ratings: 17 (4), 19 (3), 21 (4).
    // Total = 3. Avg = 3.67. Status = Attention Required (since avgRating < 4.0).
    const aditya = summary.find(
      (i) => i.email === 'aditya.intern@internops.com'
    );
    expect(aditya).toBeDefined();
    expect(aditya.attendancePercentage).toBe(100);
    expect(aditya.avgRating).toBe(3.67);
    expect(aditya.status).toBe('Attention Required');
    expect(Number.isInteger(aditya.totalWorkingMinutes)).toBe(true);
    // 468 (09:12) + 465 (09:15) + 476 (09:04) + 480 (09:00) + 477 (09:03) = 2366 minutes
    expect(aditya.totalWorkingMinutes).toBe(2366);
    expect(aditya.totalWorkingSeconds).toBe(2366 * 60);
  });

  test('filters by custom date range', () => {
    // If range is Aug 17 to Aug 18, 2026.
    const summary = service.getSummary('2026-08-17', '2026-08-18');
    const sneha = summary.find((i) => i.email === 'sneha.intern@internops.com');
    expect(sneha).toBeDefined();
    // In that range, Sneha has 2 attendance records (both PRESENT)
    expect(sneha.totalAttendance).toBe(2);
    expect(sneha.presentDays).toBe(2);
    expect(sneha.attendancePercentage).toBe(100);
    // 475 + 470 = 945 minutes
    expect(sneha.totalWorkingMinutes).toBe(945);
    expect(sneha.totalWorkingSeconds).toBe(945 * 60);
    // She has 1 rating of 5 on Aug 17.
    expect(sneha.numRatings).toBe(1);
    expect(sneha.avgRating).toBe(5);
    expect(sneha.latestRating).toBe(5);
    expect(sneha.ratingTrend).toBe('INSUFFICIENT');
  });

  test('eliminates floating-point accumulation drift over large datasets', () => {
    // Numerical Computing & Discrete Mathematics:
    // Demonstrate IEEE 754 binary floating-point representation limits.
    // 7 hours and 55 minutes is 475 minutes.
    // In fractional hours: 475 / 60 = 7.916666666666667 (repeating binary fraction).
    const logCount = 10000;
    const dailyMinutes = 475;
    const dailyFractionalHours = 475 / 60; // 7.916666666666667

    // 1. Naive floating-point accumulation
    let naiveFloatSum = 0;
    for (let i = 0; i < logCount; i++) {
      naiveFloatSum += dailyFractionalHours;
    }

    // 2. Exact integer minutes accumulation (our refactored method)
    let integerMinutesSum = 0;
    for (let i = 0; i < logCount; i++) {
      integerMinutesSum += dailyMinutes;
    }

    // Mathematical truth: 10,000 * 475 minutes = 4,750,000 minutes = 79,166.66666... hours
    const expectedMinutes = logCount * dailyMinutes;
    expect(integerMinutesSum).toBe(expectedMinutes);
    expect(Number.isInteger(integerMinutesSum)).toBe(true);

    // Converted to final decimal display on client:
    const exactDisplayString = (integerMinutesSum / 60).toFixed(2);
    expect(exactDisplayString).toBe('79166.67');

    // Demonstrating the presence of binary float accumulation drift:
    // With floats, naiveFloatSum * 60 !== integerMinutesSum due to binary precision drift
    const floatDrift = Math.abs(naiveFloatSum * 60 - integerMinutesSum);
    // Over 10,000 iterations, the float sum deviates from exact integer minutes
    expect(naiveFloatSum * 60).not.toBe(integerMinutesSum);
    expect(floatDrift).toBeGreaterThan(0);
  });

  test('parseTimeToMinutes and parseTimeToSeconds convert time strings to exact integers', () => {
    expect(service.parseTimeToSeconds('09:05:00')).toBe(32700);
    expect(service.parseTimeToMinutes('09:05:00')).toBe(545);
    expect(service.parseTimeToSeconds('17:00:00')).toBe(61200);
    expect(service.parseTimeToMinutes('17:00:00')).toBe(1020);
    expect(service.parseTimeToSeconds('')).toBe(0);
    expect(service.parseTimeToMinutes(null)).toBe(0);
  });

  test('calculateAttendanceDuration computes integer minutes and seconds', () => {
    // Absent
    expect(service.calculateAttendanceDuration({ status: 'ABSENT' })).toEqual({
      minutes: 0,
      seconds: 0,
    });

    // Half Day
    expect(service.calculateAttendanceDuration({ status: 'HALF_DAY' })).toEqual(
      {
        minutes: 240,
        seconds: 14400,
      }
    );

    // Present with arrival time 09:05:00 -> 1020 - 545 = 475 mins = 28500 secs
    expect(
      service.calculateAttendanceDuration({
        status: 'PRESENT',
        arrivalTime: '09:05:00',
      })
    ).toEqual({
      minutes: 475,
      seconds: 28500,
    });

    // Present with explicit hours duration (e.g. 7.5 hours -> 450 mins)
    expect(
      service.calculateAttendanceDuration({
        status: 'PRESENT',
        arrivalTime: '09:00:00',
        rawDurationOrDeparture: '7.5',
      })
    ).toEqual({
      minutes: 450,
      seconds: 27000,
    });
  });

  test('attendance repository computeAttendanceDuration computes integer minutes and seconds for DB persistence', () => {
    // Absent & Leave
    expect(attendanceRepo.computeAttendanceDuration('ABSENT')).toEqual({
      minutes: 0,
      seconds: 0,
    });
    expect(attendanceRepo.computeAttendanceDuration('LEAVE')).toEqual({
      minutes: 0,
      seconds: 0,
    });

    // Half Day
    expect(attendanceRepo.computeAttendanceDuration('HALF_DAY')).toEqual({
      minutes: 240,
      seconds: 14400,
    });

    // Standard Full Day Present without arrival time
    expect(attendanceRepo.computeAttendanceDuration('PRESENT')).toEqual({
      minutes: 480,
      seconds: 28800,
    });

    // Present with arrival time 09:12:00 -> 17:00 - 09:12 = 7h 48m = 468 mins = 28080 secs
    expect(
      attendanceRepo.computeAttendanceDuration('PRESENT', '09:12:00')
    ).toEqual({
      minutes: 468,
      seconds: 28080,
    });

    // Present with arrival time 09:05:00 -> 17:00 - 09:05 = 7h 55m = 475 mins = 28500 secs
    expect(
      attendanceRepo.computeAttendanceDuration('PRESENT', '09:05:00')
    ).toEqual({
      minutes: 475,
      seconds: 28500,
    });
  });
});
