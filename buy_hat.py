#!/usr/bin/env python3
"""
Human Not Required — Autonomous Hat Buyer
Your agent buys the hat. No human required.
"""

import urllib.request
import urllib.error
import json
import sys

API = "https://web-production-77376.up.railway.app"

def post(path, body, api_key=None):
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

def main():
    print("\n🤖 Human Not Required — Autonomous Hat Buyer\n")

    name         = input("Your name (for shipping label): ").strip()
    email        = input("Your email (for receipt): ").strip()
    address      = input("Street address: ").strip()
    city         = input("City: ").strip()
    state        = input("State/Province (e.g. CA, ON): ").strip()
    postal_code  = input("Postal/ZIP code: ").strip()
    country      = input("Country code (e.g. US, CA, GB): ").strip()
    promo_code   = input("Promo code: ").strip()

    print("\n🔄 Registering your account...")
    status, data = post("/register", {
        "name": name,
        "email": email,
        "promo_code": promo_code,
        "address": {
            "line1": address,
            "city": city,
            "state": state,
            "postal_code": postal_code,
            "country": country,
        }
    })

    if status == 201:
        api_key = data["api_key"]
        print(f"✅ Registered! Free orders: {data.get('free_orders_remaining', 0)}")
    elif status == 409 and data.get("error") == "already_registered":
        print("ℹ️  Already registered — fetching your API key...")
        s2, d2 = post("/register/resend-setup", {"email": email})
        api_key = d2.get("api_key")
        if not api_key:
            print("❌ Could not retrieve API key. Please contact support.")
            sys.exit(1)
    else:
        print(f"❌ Registration failed: {data.get('message', data)}")
        sys.exit(1)

    print("\n🛒 Placing your order...")
    status, data = post("/orders", {"sku": "hat-myagent-os"}, api_key=api_key)

    if status == 201:
        print(f"\n🎩 Hat ordered! Your agent bought it.")
        print(f"   Order ID: {data.get('order_id')}")
        print(f"   Confirmation sent to: {email}")
        print(f"\n   No human required. 🤖\n")
    else:
        print(f"\n❌ Order failed: {data.get('message', data)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
