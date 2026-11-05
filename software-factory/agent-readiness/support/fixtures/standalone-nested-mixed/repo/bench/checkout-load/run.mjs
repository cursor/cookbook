const started = Date.now();
let orders = 0;
while (Date.now() - started < 1000) orders++;
console.log(`${orders} simulated checkouts in one second`);
