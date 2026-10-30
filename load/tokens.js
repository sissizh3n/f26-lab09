// Claim: "a token works on any request, whichever copy answers it."
//
// Sends one token through the proxy many times. Every answer should be a 200,
// no matter which copy the proxy picked. The token comes from one copy's
// startup log (docker compose logs api).
//
//   docker compose run --rm -e TOKEN=<a u-1 token> k6 run /load/tokens.js
import http from 'k6/http';
import { check } from 'k6';
import { Gauge } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://proxy';
const TOKEN = __ENV.TOKEN;
const REQUESTS = Number(__ENV.REQUESTS || 20);

// How many distinct copies answered. Below two, a pass proves nothing: the
// script could not have seen a token one copy does not know.
const distinctUpstreams = new Gauge('distinct_upstreams');

export const options = {
  vus: 1,
  iterations: REQUESTS,
  thresholds: {
    // The claim itself: every request with the token is accepted.
    'checks{claim:token-works-on-any-copy}': ['rate==1'],
    // The guard: both copies took part.
    distinct_upstreams: ['value>=2'],
  },
};

if (!TOKEN) {
  throw new Error('Set TOKEN to a bearer token from `docker compose logs api`.');
}

// One VU, so this map sees every request: upstream -> { status: count }.
const seen = {};

export default function () {
  const res = http.get(`${BASE}/bookings`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const upstream = res.headers['X-Upstream'] || '(no X-Upstream)';
  seen[upstream] = seen[upstream] || {};
  seen[upstream][res.status] = (seen[upstream][res.status] || 0) + 1;
  distinctUpstreams.add(Object.keys(seen).length);

  check(res, { 'token accepted (200)': (r) => r.status === 200 },
    { claim: 'token-works-on-any-copy' });

  if (__ITER === REQUESTS - 1) {
    console.log(`status codes by copy (X-Upstream): ${JSON.stringify(seen)}`);
  }
}
