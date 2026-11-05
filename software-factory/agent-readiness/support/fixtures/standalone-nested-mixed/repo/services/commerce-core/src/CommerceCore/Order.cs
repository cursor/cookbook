namespace CommerceCore;

public record Order(string Id, decimal Total)
{
    public bool QualifiesForFreeShipping => Total >= 50m;
}
