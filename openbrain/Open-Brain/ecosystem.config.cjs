module.exports = {
  apps: [
    {
      name: "backend",
      script: "./backend/server.js",
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        N8N_BASE_URL: "http://localhost:5678"
      },
      env_file: ".env",
      error_file: "./backend/bridge.log",
      out_file: "./backend/bridge.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      combine_logs: true
    }
  ]
};
