module.exports = {
    apps : [
        {
          name: "verse-proxy",
          script: "./dist/main.js",
          watch: true,
          env: {
              "PORT": 8645,
              "NODE_ENV": "development",
              "DATASTORE": "redis",
              "REDIS_URI": "redis://localhost:6379/0"
          }
        }
    ]
  }
  