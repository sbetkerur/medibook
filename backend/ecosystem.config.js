module.exports = {
  apps: [{
    name: 'medibook-backend',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',       // single process — cluster mode causes EADDRINUSE on restart
    autorestart: true,       // restart if it crashes
    watch: false,            // don't restart on file changes in production
    max_memory_restart: '512M',  // restart if memory exceeds 512MB (memory leak protection)
    restart_delay: 3000,     // wait 3s before restarting after a crash
    max_restarts: 10,        // stop restarting after 10 crashes in a row (prevents restart loop)
    min_uptime: '10s',       // must stay up 10s to count as a successful start
    exp_backoff_restart_delay: 100,  // exponential backoff on repeated crashes
    // Do not set NODE_ENV here — use whatever is in .env
    // Setting 'production' here would override .env and enable strict signature
    // verification that blocks the local test endpoint and dev fallback paths.
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
  }],
};
