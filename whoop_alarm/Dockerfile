FROM node:20-alpine

WORKDIR /app
COPY whoop-core.mjs server.mjs /app/

# Kein npm install noetig - reine Node-Bordmittel.
CMD [ "node", "/app/server.mjs" ]
