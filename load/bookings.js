// Claim: "a room slot is booked at most once."
//
// Asks for the same room and the same slot twice, once on each copy, straight
// to the copy rather than through the proxy, each with that copy's own token.
// (Through the proxy, a token from one copy gets a 401 from the other, so the
// booking would never reach the conflict check.) At most one of the two may come
// back confirmed; the other should be waitlisted.
//
//   docker compose run --rm \
//     -e TOKEN_A=<u-1 token from api-1> -e TOKEN_B=<u-2 token from api-2> \
//     k6 run /load/bookings.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const COPY_A = __ENV.COPY_A || 'http://f26-lab09-api-1:8080';
const COPY_B = __ENV.COPY_B || 'http://f26-lab09-api-2:8080';
const TOKEN_A = __ENV.TOKEN_A;
const TOKEN_B = __ENV.TOKEN_B;
const ROOM = __ENV.ROOM || 'r-1';

// Slots where both copies confirmed the same room and time.
const doubleBookings = new Counter('double_bookings');
// The guard: the two requests landed on two different machines.
const reachedTwoCopies = new Rate('reached_two_copies');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    'checks{claim:slot-booked-at-most-once}': ['rate==1'],
    double_bookings: ['count==0'],
    reached_two_copies: ['rate==1'],
  },
};

if (!TOKEN_A || !TOKEN_B) {
  throw new Error('Set TOKEN_A (from api-1) and TOKEN_B (from api-2), from `docker compose logs api`.');
}

// A slot the booking rules accept for r-1: 06:00-22:00 UTC, 15-minute aligned,
// and at most 14 days ahead (BookingPolicy.defaults() allows 60, but RoomKind
// STUDY_ROOM narrows it to 14). Picked fresh each run so a second run on the same
// stack does not land on the slot the first one took. SLOT=...T14:00:00Z pins it.
function pickSlot() {
  if (__ENV.SLOT) {
    return __ENV.SLOT;
  }
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 2 + Math.floor(Math.random() * 12));
  day.setUTCHours(6 + Math.floor(Math.random() * 14), 15 * Math.floor(Math.random() * 4), 0, 0);
  return day.toISOString().replace('.000Z', 'Z');
}

function book(base, token, start) {
  return http.post(`${base}/bookings`, { roomId: ROOM, start: start, minutes: '60' }, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export default function () {
  const start = pickSlot();
  const a = book(COPY_A, TOKEN_A, start);
  const b = book(COPY_B, TOKEN_B, start);

  for (const [name, res] of [['A', a], ['B', b]]) {
    console.log(`copy ${name} (${res.remote_ip}) ${ROOM} @ ${start}: ${res.status} ${res.body}`);
  }

  // Both must have been read by a copy at all, or the result says nothing.
  const bothServed = check(null, {
    'copy A accepted the request (201 or 202)': () => a.status === 201 || a.status === 202,
    'copy B accepted the request (201 or 202)': () => b.status === 201 || b.status === 202,
  });
  reachedTwoCopies.add(bothServed && a.remote_ip !== b.remote_ip);

  const confirmed = [a, b].filter((res) => res.status === 201).length;
  if (confirmed > 1) {
    doubleBookings.add(1);
  }
  check(confirmed, { 'at most one copy confirmed the slot': (n) => n <= 1 },
    { claim: 'slot-booked-at-most-once' });
}
