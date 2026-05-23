const app  = require('./app');
const port = parseInt(process.env.PORT || '4000');
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  console.log(`Scheduler API running on http://${host}:${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
