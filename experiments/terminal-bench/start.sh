#!/bin/sh
# 컨테이너 안에서 Parism MCP 서버를 시작한다. 호스트 설정 파일을 홈 디렉터리에 둔 뒤 실행한다.
mkdir -p "$HOME/.parism"
cp /opt/parism/prism.config.json "$HOME/.parism/prism.config.json"
exec /opt/parism-node/bin/node /opt/parism/dist/index.js
