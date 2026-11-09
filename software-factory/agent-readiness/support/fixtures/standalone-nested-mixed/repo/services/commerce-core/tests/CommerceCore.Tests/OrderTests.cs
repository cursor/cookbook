namespace CommerceCore.Tests;

public class OrderTests
{
    public void FreeShippingStartsAtFifty()
    {
        if (new Order("a", 49m).QualifiesForFreeShipping) throw new Exception("49 should not ship free");
        if (!new Order("b", 50m).QualifiesForFreeShipping) throw new Exception("50 should ship free");
    }
}
