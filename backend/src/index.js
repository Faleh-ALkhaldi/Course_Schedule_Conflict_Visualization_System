const app  = require('./app');
const port = parseInt(process.env.PORT || '4000');

app.listen(port, () => {
  console.log(`Scheduler API running on http://localhost:${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
