namespace CommerceCore;

public static class Orders
{
    public static decimal Total(decimal price, int quantity) => quantity < 1 ? 0 : price * quantity;
}
