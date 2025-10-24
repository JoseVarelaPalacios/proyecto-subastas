#!/usr/bin/env python3
# app.py
"""
Servidor simple de subastas (prototipo)
- Flask para endpoints
- sqlite3 para persistencia ligera
- Lock por auction_id para manejar exclusión mutua en la actualización de pujas
"""

from flask import Flask, request, jsonify
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from flask_cors import CORS

DB = "auctions.db"
app = Flask(__name__)
CORS(app)

# Locks por subasta (auction_id -> threading.Lock)
auction_locks = {}
auction_locks_lock = threading.Lock()  # protege el diccionario auction_locks

def get_auction_lock(auction_id: int) -> threading.Lock:
    """Obtiene o crea de forma segura el lock para una subasta."""
    with auction_locks_lock:
        if auction_id not in auction_locks:
            auction_locks[auction_id] = threading.Lock()
        return auction_locks[auction_id]

def init_db():
    con = sqlite3.connect(DB, check_same_thread=False)
    cur = con.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
    );
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS auctions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        current_price REAL NOT NULL DEFAULT 0,
        current_winner INTEGER NULL,
        min_increment REAL NOT NULL DEFAULT 1,
        end_time INTEGER NOT NULL, -- epoch seconds
        active INTEGER NOT NULL DEFAULT 1
    );
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS bids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auction_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        ts INTEGER NOT NULL,
        FOREIGN KEY(auction_id) REFERENCES auctions(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
    """)
    con.commit()
    con.close()

def db_connect():
    return sqlite3.connect(DB, check_same_thread=False)

@app.route("/user", methods=["POST"])
def create_user():
    data = request.json or {}
    name = data.get("name")
    if not name:
        return jsonify({"error":"name required"}), 400
    con = db_connect()
    cur = con.cursor()
    cur.execute("INSERT INTO users (name, active) VALUES (?,1)", (name,))
    user_id = cur.lastrowid
    con.commit()
    con.close()
    return jsonify({"user_id": user_id, "name": name}), 201

@app.route("/auction", methods=["POST"])
def create_auction():
    data = request.json or {}
    item_name = data.get("item_name")
    start_price = float(data.get("start_price", 0))
    min_increment = float(data.get("min_increment", 1))
    duration_seconds = int(data.get("duration_seconds", 60))  # duración por defecto 60s
    if not item_name:
        return jsonify({"error":"item_name required"}), 400
    end_time = int(time.time()) + duration_seconds
    con = db_connect()
    cur = con.cursor()
    cur.execute(
        "INSERT INTO auctions (item_name, current_price, min_increment, end_time, active) VALUES (?,?,?,?,1)",
        (item_name, start_price, min_increment, end_time)
    )
    auction_id = cur.lastrowid
    con.commit()
    con.close()
    return jsonify({"auction_id": auction_id, "item_name": item_name, "end_time": end_time}), 201

@app.route("/auction/<int:auction_id>", methods=["GET"])
def get_auction(auction_id):
    con = db_connect()
    cur = con.cursor()
    cur.execute("SELECT id,item_name,current_price,current_winner,min_increment,end_time,active FROM auctions WHERE id=?", (auction_id,))
    row = cur.fetchone()
    con.close()
    if not row:
        return jsonify({"error":"auction not found"}), 404
    (aid,item_name,current_price,current_winner,min_increment,end_time,active) = row
    return jsonify({
        "id": aid,
        "item_name": item_name,
        "current_price": current_price,
        "current_winner": current_winner,
        "min_increment": min_increment,
        "end_time": end_time,
        "active": bool(active)
    })

@app.route("/bid", methods=["POST"])
def place_bid():
    """
    Body JSON: { "auction_id": int, "user_id": int, "amount": float }
    """
    data = request.json or {}
    try:
        auction_id = int(data.get("auction_id"))
        user_id = int(data.get("user_id"))
        amount = float(data.get("amount"))
    except Exception:
        return jsonify({"error":"auction_id, user_id, amount required and must be numeric"}), 400

    # Basic checks: auction exists, user exists
    con = db_connect()
    cur = con.cursor()
    cur.execute("SELECT id, current_price, min_increment, end_time, active FROM auctions WHERE id = ?", (auction_id,))
    auction_row = cur.fetchone()
    if not auction_row:
        con.close()
        return jsonify({"error":"auction not found"}), 404

    _, current_price, min_increment, end_time, active = auction_row

    # check auction time and active flag
    now_ts = int(time.time())
    if not active or now_ts > end_time:
        # mark inactive if time passed
        if now_ts > end_time:
            cur.execute("UPDATE auctions SET active=0 WHERE id=?", (auction_id,))
            con.commit()
        con.close()
        return jsonify({"error":"auction closed"}), 400

    cur.execute("SELECT id, name, active FROM users WHERE id = ?", (user_id,))
    user_row = cur.fetchone()
    if not user_row:
        con.close()
        return jsonify({"error":"user not found"}), 404
    if not user_row[2]:
        con.close()
        return jsonify({"error":"user not active"}), 400

    # Acquire lock for this auction to protect the critical region:
    lock = get_auction_lock(auction_id)
    acquired = lock.acquire(timeout=5)  # espera hasta 5s para evitar deadlocks permanentes
    if not acquired:
        con.close()
        return jsonify({"error":"could not acquire auction lock, try again"}), 500

    try:
        # Re-read the current price inside the lock (double-check)
        cur.execute("SELECT current_price FROM auctions WHERE id = ?", (auction_id,))
        row2 = cur.fetchone()
        if not row2:
            return jsonify({"error":"auction not found (post-lock)"}), 404
        current_price = float(row2[0])
        required_min = current_price + float(min_increment)

        if amount < required_min:
            return jsonify({
                "success": False,
                "reason": "amount_too_low",
                "current_price": current_price,
                "required_minimum": required_min
            }), 400

        # All good: insert bid and update auction
        ts = now_ts
        cur.execute(
            "INSERT INTO bids (auction_id, user_id, amount, ts) VALUES (?,?,?,?)",
            (auction_id, user_id, amount, ts)
        )
        cur.execute(
            "UPDATE auctions SET current_price=?, current_winner=? WHERE id=?",
            (amount, user_id, auction_id)
        )
        con.commit()

        return jsonify({
            "success": True,
            "auction_id": auction_id,
            "user_id": user_id,
            "amount": amount,
            "current_price": amount
        }), 200

    finally:
        lock.release()
        con.close()

@app.route("/bids/<int:auction_id>", methods=["GET"])
def list_bids(auction_id):
    con = db_connect()
    cur = con.cursor()
    cur.execute("SELECT id, user_id, amount, ts FROM bids WHERE auction_id=? ORDER BY ts ASC", (auction_id,))
    rows = cur.fetchall()
    con.close()
    res = [{"id":r[0],"user_id":r[1],"amount":r[2],"ts":r[3]} for r in rows]
    return jsonify(res)

# --- util endpoint to close auction (force) ---
@app.route("/auction/<int:auction_id>/close", methods=["POST"])
def close_auction(auction_id):
    con = db_connect()
    cur = con.cursor()
    cur.execute("UPDATE auctions SET active=0 WHERE id=?", (auction_id,))
    con.commit()
    con.close()
    return jsonify({"closed": auction_id})

@app.route("/users", methods=["GET"])
def list_users():
    con = db_connect()
    cur = con.cursor()
    cur.execute("SELECT id, name, active FROM users")
    rows = cur.fetchall()
    con.close()
    result = [
        {"id": r[0], "name": r[1], "active": bool(r[2])}
        for r in rows
    ]
    return jsonify(result)

@app.route("/auctions", methods=["GET"])
def list_auctions():
    """Lista todas las subastas activas (o todas, si se pasa ?all=1) y actualiza estados vencidos."""
    show_all = request.args.get("all") == "1"
    now = int(time.time())

    con = db_connect()
    cur = con.cursor()

    # 🔄 Actualizar automáticamente subastas vencidas
    cur.execute("UPDATE auctions SET active=0 WHERE active=1 AND end_time < ?", (now,))
    con.commit()

    # Luego listamos
    if show_all:
        cur.execute("SELECT id, item_name, current_price, current_winner, active, end_time FROM auctions ORDER BY id DESC")
    else:
        cur.execute("SELECT id, item_name, current_price, current_winner, active, end_time FROM auctions WHERE active=1 ORDER BY id DESC")
    rows = cur.fetchall()
    con.close()

    return jsonify([
        {
            "id": r[0],
            "item_name": r[1],
            "current_price": r[2],
            "current_winner": r[3],
            "active": bool(r[4]),
            "end_time": r[5]
        }
        for r in rows
    ])



if __name__ == "__main__":
    init_db()
    # Opcional: crear datos de ejemplo si se quiere
    # Levanta servidor en 127.0.0.1:5000
    app.run(host="0.0.0.0", port=5000, threaded=True)
