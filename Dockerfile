# HTTP-only actor (no browser). impit ships prebuilt native binaries selected by npm.
FROM apify/actor-node:22

# Copy just package.json and package-lock.json
# to speed up the build using Docker layer cache.
COPY --chown=myuser:myuser package*.json Dockerfile ./

# Install NPM packages, skip optional and development dependencies to
# keep the image small. Verify the platform-selected impit binary is present.
RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && node -e "import('impit').then(m => console.log('impit OK:', Object.keys(m)))" \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Next, copy the remaining files and directories with the source code.
COPY --chown=myuser:myuser . ./

CMD npm start --silent
