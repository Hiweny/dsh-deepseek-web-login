#!/usr/bin/env bash
# 模拟器冒烟测试：安装 → 起服务 → 用 adb forward 从宿主机打 HTTP 断言
set -eux

APK=$(ls ./apk/*.apk | head -1)
echo "APK=$APK"
adb install -r "$APK"

adb shell pm grant com.hiweny.dshweb android.permission.POST_NOTIFICATIONS || true
adb shell am start -n com.hiweny.dshweb/.MainActivity
sleep 30

echo "== app log =="
adb shell "run-as com.hiweny.dshweb cat files/dsh.log" 2>/dev/null | tail -50 || true

adb forward tcp:8787 tcp:8787

echo "== /health =="
HEALTH=$(curl -s -m 25 http://127.0.0.1:8787/health || true)
echo "$HEALTH"

echo "== /v1/models =="
MODELS=$(curl -s -m 25 http://127.0.0.1:8787/v1/models || true)
echo "$MODELS"

echo "== /api/status =="
curl -s -m 25 http://127.0.0.1:8787/api/status | head -c 2000 || true
echo

echo "== /v1/chat/completions (no login expected) =="
curl -s -m 90 -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer sk-dshweb" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}' | head -c 500 || true
echo

adb exec-out screencap -p > shot.png || true
adb logcat -d -s DSHWEB:* | tail -80 || true

echo "$HEALTH" | grep -q '"ok":true'
echo "$MODELS" | grep -q 'deepseek-chat'
adb forward --remove tcp:8787 || true
echo "E2E ASSERTIONS PASSED"
