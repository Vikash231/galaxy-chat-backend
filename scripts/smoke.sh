#!/usr/bin/env bash
# Calls every Day 1 endpoint and checks the status code. Usage: BASE=http://localhost:3000 scripts/smoke.sh
set -uo pipefail
BASE=${BASE:-http://localhost:3000}
ORIGIN=${FRONTEND_ORIGIN:-http://localhost:3001}
cd "$(dirname "$0")/.."
A="Authorization: Bearer $(node scripts/dev-token.mjs user_smoke_a)"
B="Authorization: Bearer $(node scripts/dev-token.mjs user_smoke_b)"
J="content-type: application/json"
pass=0; fail=0

# check <name> <expected codes, e.g. 200|202> <curl args...>; body lands in $BODY
check() {
  local name=$1 want=$2; shift 2
  local out code
  out=$(curl -s -w '\n%{http_code}' "$@"); code=${out##*$'\n'}; BODY=${out%$'\n'*}
  if [[ "|$want|" == *"|$code|"* ]]; then pass=$((pass+1)); printf '  PASS  %-44s %s\n' "$name" "$code"
  else fail=$((fail+1)); printf '  FAIL  %-44s got %s, want %s\n        %s\n' "$name" "$code" "$want" "${BODY:0:300}"; fi
}
field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(d||"{}"));console.log(v??"")})' "$1" <<<"$BODY"; }
uuid() { node -e 'console.log(crypto.randomUUID())'; }

echo "Smoke test against $BASE"
check "GET  /api/health"                         200 "$BASE/api/health"
check "GET  /api/openapi.json"                   200 "$BASE/api/openapi.json"
check "GET  /v1/me without token"                401 "$BASE/api/v1/me"
check "GET  /v1/me"                              200 -H "$A" "$BASE/api/v1/me"
check "OPTIONS preflight from frontend origin"   204 -X OPTIONS -H "Origin: $ORIGIN" "$BASE/api/v1/me"
check "POST /v1/chats"                           201 -H "$A" -H "$J" -d '{"title":"Smoke test"}' "$BASE/api/v1/chats"
CHAT=$(field id)
check "GET  /v1/chats"                           200 -H "$A" "$BASE/api/v1/chats?limit=5"
check "GET  /v1/chats/:id"                       200 -H "$A" "$BASE/api/v1/chats/$CHAT"
check "GET  /v1/chats/:id as another user"       404 -H "$B" "$BASE/api/v1/chats/$CHAT"
check "POST /v1/chats/:id/messages invalid body" 422 -H "$A" -H "$J" -d '{"text":""}' "$BASE/api/v1/chats/$CHAT/messages"

CMID=$(uuid)
SEND='{"clientMessageId":"'$CMID'","text":"Crop the left half of https://picsum.photos/id/237/800/600.jpg"}'
check "POST /v1/chats/:id/messages"              "202|503" -H "$A" -H "$J" -d "$SEND" "$BASE/api/v1/chats/$CHAT/messages"
SENT=$BODY; RUN=$(field runId); [[ -z "$RUN" ]] && RUN=$(field error.details.runId)
if [[ "$SENT" == *dispatch_failed* ]]; then
  echo "        note: 503 means Trigger.dev is not configured (TRIGGER_SECRET_KEY); the run was saved and marked failed."
else
  check "POST same clientMessageId (replay)"     200 -H "$A" -H "$J" -d "$SEND" "$BASE/api/v1/chats/$CHAT/messages"
  [[ $(field runId) == "$RUN" ]] && echo "        replay returned the same runId" || echo "        WARN replay returned a different run"
  check "POST second message while running"      "409|202" -H "$A" -H "$J" -d '{"clientMessageId":"'$(uuid)'","text":"hi"}' "$BASE/api/v1/chats/$CHAT/messages"
  check "POST /v1/runs/:id/token"                200 -X POST -H "$A" "$BASE/api/v1/runs/$RUN/token"
fi
check "GET  /v1/chats/:id/messages"              200 -H "$A" "$BASE/api/v1/chats/$CHAT/messages?limit=10"
check "GET  /v1/runs/:id"                        200 -H "$A" "$BASE/api/v1/runs/$RUN"
check "GET  /v1/runs/:id as another user"        404 -H "$B" "$BASE/api/v1/runs/$RUN"

if [[ "$SENT" != *dispatch_failed* && "${WAIT:-1}" == 1 ]]; then
  echo "  ...waiting up to 90s for the run to finish (needs the worker: pnpm dev:worker)"
  for _ in $(seq 1 45); do
    curl -s -H "$A" "$BASE/api/v1/runs/$RUN" > /tmp/gx_run.json
    STATUS=$(node -e 'console.log(require("/tmp/gx_run.json").run?.status)')
    [[ "$STATUS" =~ ^(completed|failed|cancelled)$ ]] && break; sleep 2
  done
  node -e 'const r=require("/tmp/gx_run.json");console.log("        run:",r.run.status,"| steps:",r.run.steps,"| models:",r.run.routedModels.join(", ")||"-");for(const t of r.tools)console.log("        tool:",t.name,t.status,"credits",t.credits,t.output?JSON.stringify(t.output):"",t.error?.message??"");const m=r.assistantMessage;if(m)console.log("        reply:",m.content.filter(b=>b.type==="text").map(b=>b.text).join(" ").slice(0,200)||m.error?.message)'
fi
check "POST /v1/runs/:id/cancel"                 "200|202" -X POST -H "$A" "$BASE/api/v1/runs/$RUN/cancel"

echo; echo "$pass passed, $fail failed"; [[ $fail == 0 ]]
