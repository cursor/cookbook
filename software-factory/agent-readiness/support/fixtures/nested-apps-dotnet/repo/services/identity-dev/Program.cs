var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/health", () => "ok");
app.Run();
