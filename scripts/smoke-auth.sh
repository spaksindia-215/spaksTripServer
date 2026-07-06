#!/usr/bin/env bash
# End-to-end auth / role-isolation smoke test for SpaksTrip.
#
# Prereqs: Node >= 20.9, a running Mongo, and server/.env populated with
# MONGO_URI, ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET, SUPERADMIN_PASSWORD,
# ADMIN_SESSION_SECRET. Start the API first:  npm run dev   (in server/)
#
# Usage:  BASE=http://localhost:4000 ADMIN_PW=yourpw bash scripts/smoke-auth.sh
#
# It exercises: per-role registration, pending gating, phone login, admin
# approval + credit limit, refresh-token rotation/revocation, and cross-role
# data isolation. Each step prints the HTTP status; ✗ marks an unexpected one.

set -u
BASE="${BASE:-http://localhost:4000}"
ADMIN_PW="${ADMIN_PW:-changeme}"
TMP="$(mktemp -d)"
PASS="Passw0rd!"
RND="$RANDOM"

cust_jar="$TMP/cust.jar"; agent_jar="$TMP/agent.jar"; b2b_jar="$TMP/b2b.jar"; admin_jar="$TMP/admin.jar"

# req METHOD PATH JAR [JSON]  -> echoes HTTP status, saves body to $TMP/body
req() {
  local method="$1" path="$2" jar="$3" data="${4:-}"
  if [ -n "$data" ]; then
    curl -s -o "$TMP/body" -w "%{http_code}" -X "$method" "$BASE$path" \
      -H "Content-Type: application/json" -c "$jar" -b "$jar" -d "$data"
  else
    curl -s -o "$TMP/body" -w "%{http_code}" -X "$method" "$BASE$path" -c "$jar" -b "$jar"
  fi
}

check() { # check EXPECTED ACTUAL LABEL
  if [ "$1" = "$2" ]; then echo "  ✓ $3 ($2)"; else echo "  ✗ $3 (expected $1, got $2)"; cat "$TMP/body"; echo; fi
}

json_field() {
  node -e 'const fs = require("fs"); const key = process.argv[2]; const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(payload?.[key] ?? ""));' "$TMP/body" "$1"
}

echo "== 1. Customer registers (instant active) =="
code=$(req POST /api/auth/register "$cust_jar" \
  "{\"name\":\"Cust One\",\"phone\":\"90000$RND\",\"email\":\"cust$RND@ex.com\",\"password\":\"$PASS\",\"role\":\"customer\",\"aadhar\":\"123412341234\"}")
check 201 "$code" "customer register"

echo "== 2. Customer /me works =="
code=$(req GET /api/auth/me "$cust_jar"); check 200 "$code" "customer me"

echo "== 3. Agent registers (instant active) =="
code=$(req POST /api/auth/register "$agent_jar" \
  "{\"name\":\"Agent One\",\"phone\":\"91000$RND\",\"email\":\"agent$RND@ex.com\",\"password\":\"$PASS\",\"role\":\"agent\",\"aadhar\":\"123412341234\"}")
check 201 "$code" "agent register"

echo "== 4. B2B registers -> pending, no session =="
code=$(req POST /api/auth/register "$b2b_jar" \
  "{\"name\":\"B2B One\",\"phone\":\"92000$RND\",\"email\":\"b2b$RND@ex.com\",\"password\":\"$PASS\",\"role\":\"b2b_agent\",\"aadhar\":\"123412341234\",\"gst\":\"22AAAAA0000A1Z5\",\"pan\":\"ABCDE1234F\"}")
check 201 "$code" "b2b register (pending)"

echo "== 5. B2B login blocked while pending =="
code=$(req POST /api/auth/login "$b2b_jar" "{\"phone\":\"92000$RND\",\"password\":\"$PASS\"}")
check 403 "$code" "pending login blocked"

echo "== 6. Admin login (wrong then correct) =="
code=$(req POST /api/admin/login "$admin_jar" "{\"password\":\"definitely-wrong\"}"); check 401 "$code" "admin wrong pw"
code=$(req POST /api/admin/login "$admin_jar" "{\"password\":\"$ADMIN_PW\"}");      check 200 "$code" "admin correct pw"

echo "== 7. Admin sees pending, approves B2B with credit limit =="
code=$(req GET /api/admin/pending "$admin_jar"); check 200 "$code" "admin pending list"
B2B_ID=$(grep -o '"id":"[a-f0-9]\{24\}"' "$TMP/body" | head -1 | cut -d'"' -f4)
code=$(req POST "/api/admin/approve/$B2B_ID" "$admin_jar" "{\"creditLimit\":50000}"); check 200 "$code" "approve b2b (₹50k)"

echo "== 8. B2B can now log in =="
code=$(req POST /api/auth/login "$b2b_jar" "{\"phone\":\"92000$RND\",\"password\":\"$PASS\"}")
check 200 "$code" "b2b login challenge issued"
CHALLENGE_ID=$(json_field challengeId)
OTP_CODE=$(json_field debugCode)
if [ -z "$OTP_CODE" ]; then
  echo "  ✗ b2b OTP code missing from dev response"
  cat "$TMP/body"
  echo
  exit 1
fi
code=$(req POST /api/auth/login/verify-otp "$b2b_jar" "{\"challengeId\":\"$CHALLENGE_ID\",\"code\":\"$OTP_CODE\"}")
check 200 "$code" "b2b login after approval"

echo "== 9. Cross-role isolation: customer hitting agent API => 403 =="
code=$(req GET /api/agent/bookings "$cust_jar"); check 403 "$code" "customer blocked from /api/agent"
code=$(req GET /api/partner/resources "$cust_jar"); check 403 "$code" "customer blocked from /api/partner"

echo "== 10. Agent credit guard (no limit set) then within-limit hold =="
code=$(req POST /api/agent/bookings "$agent_jar" "{\"productType\":\"flight\",\"amount\":1000,\"status\":\"held\"}")
check 403 "$code" "hold blocked (agent has no credit limit)"
# B2B has a 50k limit -> a small hold should pass
code=$(req POST /api/agent/bookings "$b2b_jar" "{\"productType\":\"flight\",\"amount\":1000,\"status\":\"held\"}")
check 201 "$code" "b2b hold within credit"
# Over the limit -> blocked
code=$(req POST /api/agent/bookings "$b2b_jar" "{\"productType\":\"flight\",\"amount\":999999,\"status\":\"held\"}")
check 403 "$code" "b2b hold over credit blocked"

echo "== 11. Refresh-token rotation: reusing an old refresh token fails =="
cp "$cust_jar" "$TMP/cust.before"     # snapshot cookie (old refresh token)
code=$(req POST /api/auth/refresh "$cust_jar"); check 200 "$code" "first refresh (rotates)"
# Replay the OLD cookie jar -> old token now revoked
code=$(req POST /api/auth/refresh "$TMP/cust.before"); check 401 "$code" "reused old refresh rejected"

echo "== 12. Logout revokes refresh =="
code=$(req POST /api/auth/logout "$cust_jar"); check 200 "$code" "logout"

echo ""
echo "Done. Review any ✗ above. Temp files: $TMP"
