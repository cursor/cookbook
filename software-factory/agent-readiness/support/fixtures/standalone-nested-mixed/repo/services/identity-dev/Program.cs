var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/signin", () => "dev-user");
app.Run();
