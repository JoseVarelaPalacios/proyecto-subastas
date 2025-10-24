import React, { useEffect, useState, useRef, useMemo } from "react";

export default function AuctionApp() {
  const API = import.meta.env.VITE_AUCTION_API || "http://127.0.0.1:5000";

  // Usuarios
  const [users, setUsers] = useState([]);
  const [nameInput, setNameInput] = useState("");
  const [selectedUserId, setSelectedUserId] = useState(null);

  // Subastas
  const [createdAuctionId, setCreatedAuctionId] = useState("");
  const [auctionForm, setAuctionForm] = useState({
    item_name: "",
    start_price: 0,
    min_increment: 1,
    duration_seconds: 60,
  });

  // Estado de subasta
  const [loadedAuctionId, setLoadedAuctionId] = useState("");
  const [auctionStatus, setAuctionStatus] = useState(null);
  const [bids, setBids] = useState([]);
  const [bidAmount, setBidAmount] = useState("");
  const [message, setMessage] = useState("");
  const [isBidding, setIsBidding] = useState(false);
  const [auctions, setAuctions] = useState([]);
  const [timeLeft, setTimeLeft] = useState("");

  const userMap = useMemo(() => {
    const map = {};
    users.forEach((u) => {
      map[u.id] = u.name;
    });
    return map;
  }, [users]);

  const pollRef = useRef(null);

  // === Funciones auxiliares ===

  async function fetchUsers() {
    try {
      const res = await fetch(`${API}/users`);
      if (!res.ok) throw new Error(`Error al obtener usuarios`);
      const data = await res.json();
      setUsers(data);
      if (!selectedUserId && data.length > 0) setSelectedUserId(data[0].id);
    } catch (err) {
      console.error(err);
      setMessage(err.message);
    }
  }

  async function fetchAuctions() {
    try {
      const res = await fetch(`${API}/auctions`);
      if (!res.ok) throw new Error("Error al obtener subastas");
      const data = await res.json();
      setAuctions(data);
    } catch (err) {
      console.error(err);
      setMessage(err.message);
    }
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    if (!nameInput.trim()) return setMessage("Ingresa un nombre válido");
    try {
      const res = await fetch(`${API}/user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || JSON.stringify(data));
      setNameInput("");
      setMessage(`Usuario creado: ${data.name} (id ${data.user_id})`);
      await fetchUsers();
      setSelectedUserId(data.user_id);
    } catch (err) {
      console.error(err);
      setMessage(err.message);
    }
  }

  async function handleCreateAuction(e) {
    e.preventDefault();
    if (!auctionForm.item_name.trim())
      return setMessage("Nombre del artículo requerido");
    try {
      const res = await fetch(`${API}/auction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(auctionForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || JSON.stringify(data));
      setCreatedAuctionId(data.auction_id);
      setLoadedAuctionId(String(data.auction_id));
      setMessage(`Subasta creada: ${data.item_name} (id ${data.auction_id})`);
      await loadAuction(String(data.auction_id));
    } catch (err) {
      console.error(err);
      setMessage(err.message);
    }
  }

  async function loadAuction(id) {
    if (!id) return setMessage("Ingresa un ID de subasta para cargar");
    try {
      const res = await fetch(`${API}/auction/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || JSON.stringify(data));
      setAuctionStatus(data);
      const rb = await fetch(`${API}/bids/${id}`);
      const bidsJson = await rb.json();
      setBids(bidsJson);
      setMessage(`Subasta ${id} cargada`);
    } catch (err) {
      console.error(err);
      setAuctionStatus(null);
      setBids([]);
      setMessage(`No se pudo cargar la subasta ${id}: ${err.message}`);
    }
  }

  async function handlePlaceBid(e) {
    e.preventDefault();
    if (!loadedAuctionId) return setMessage("Carga primero la subasta");
    if (!selectedUserId) return setMessage("Selecciona un usuario");
    const amt = parseFloat(bidAmount);
    if (Number.isNaN(amt) || amt <= 0)
      return setMessage("Ingresa un monto válido");

    setIsBidding(true); // <-- AÑADIDO: Deshabilita el botón

    try {
      const res = await fetch(`${API}/bid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auction_id: Number(loadedAuctionId),
          user_id: Number(selectedUserId),
          amount: amt,
        }),
      });
      const data = await res.json();

      // Manejo de error mejorado que sugerí antes
      if (!res.ok) {
        let errorMsg = data.error || JSON.stringify(data);
        if (data.reason === "amount_too_low") {
          errorMsg = `Puja fallida. El precio actual es $${data.current_price}. Debes pujar al menos $${data.required_minimum}.`;
        }
        throw new Error(errorMsg);
      }

      setMessage(`Puja exitosa: ${amt}`);
      setBidAmount("");
      await loadAuction(loadedAuctionId);
    } catch (err) {
      console.error(err);
      setMessage(`Error en la puja: ${err.message}`);
    } finally {
      setIsBidding(false); // <-- AÑADIDO: Vuelve a habilitar el botón
    }
  }

  function fmtTs(ts) {
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  // === Efectos ===
  useEffect(() => {
    fetchUsers();
    fetchAuctions();
    const interval = setInterval(fetchAuctions, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!loadedAuctionId) return;
    loadAuction(loadedAuctionId);
    pollRef.current = setInterval(() => {
      loadAuction(loadedAuctionId);
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [loadedAuctionId]);

  // --- INICIO: Bloque de Temporizador ---

  function calculateTimeLeft(endTime) {
    const end = endTime * 1000; // Convertir a milisegundos
    const diff = end - Date.now();

    if (diff <= 0) return "Finalizada";

    const s = Math.floor((diff / 1000) % 60);
    const m = Math.floor((diff / 1000 / 60) % 60);
    const h = Math.floor((diff / (1000 * 60 * 60)) % 24);

    return `${h > 0 ? h + "h " : ""}${m}m ${s}s`;
  }

  useEffect(() => {
    // Si no hay subasta, o está inactiva, o ya pasó el tiempo
    if (
      !auctionStatus ||
      !auctionStatus.active ||
      auctionStatus.end_time * 1000 < Date.now()
    ) {
      setTimeLeft(auctionStatus ? "Finalizada" : "—");
      return;
    }

    // Actualiza el contador una vez inmediatamente
    setTimeLeft(calculateTimeLeft(auctionStatus.end_time));

    // Y luego actualiza cada segundo
    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft(auctionStatus.end_time));
    }, 1000);

    // Limpia el intervalo cuando el componente se desmonte o la subasta cambie
    return () => clearInterval(timer);
  }, [auctionStatus]); // Se ejecuta cada vez que 'auctionStatus' cambia

  // --- FIN: Bloque de Temporizador ---

  // === Render ===
  return (
    <div className="app-container">
      <header className="header">
        <h1>Panel de Subastas</h1>
        <small>React + Flask</small>
      </header>
      {/* Crear usuario */}
      <section className="section">
        <h2>Crear usuario</h2>
        <form onSubmit={handleCreateUser}>
          <input
            placeholder="Nombre del usuario"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
          />
          <button type="submit">Crear usuario</button>
        </form>

        <label>Usuarios existentes:</label>
        <select
          value={selectedUserId || ""}
          onChange={(e) => setSelectedUserId(Number(e.target.value))}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.id} — {u.name}
            </option>
          ))}
        </select>
        <small>Selecciona el usuario que hará las pujas.</small>
      </section>
      {/* Crear subasta */}
      <section className="section">
        <h2>Crear subasta</h2>
        <form onSubmit={handleCreateAuction}>
          <label>
            Nombre del artículo
            <input
              placeholder="Articulo"
              value={auctionForm.item_name}
              onChange={(e) =>
                setAuctionForm({ ...auctionForm, item_name: e.target.value })
              }
            />
          </label>

          <label>
            Precio inicial ($)
            <input
              type="number"
              value={auctionForm.start_price}
              onChange={(e) =>
                setAuctionForm({
                  ...auctionForm,
                  start_price: Number(e.target.value),
                })
              }
            />
          </label>

          <label>
            Incremento mínimo ($)
            <input
              type="number"
              placeholder="Ejemplo: 50"
              value={auctionForm.min_increment}
              onChange={(e) =>
                setAuctionForm({
                  ...auctionForm,
                  min_increment: Number(e.target.value),
                })
              }
            />
          </label>

          <label>
            Duración (segundos)
            <input
              type="number"
              placeholder="Ejemplo: 60"
              value={auctionForm.duration_seconds}
              onChange={(e) =>
                setAuctionForm({
                  ...auctionForm,
                  duration_seconds: Number(e.target.value),
                })
              }
            />
          </label>

          <button type="submit">Crear subasta</button>
          <small>ID creada: {createdAuctionId || "—"}</small>
        </form>
      </section>
      {/* Subastas activas */}
      <section className="section">
        <h2>Subastas activas</h2>
        {auctions.length === 0 ? (
          <div className="message">No hay subastas activas.</div>
        ) : (
          <ul className="auction-list">
            {auctions.map((a) => (
              <li
                key={a.id}
                className={`auction-item ${
                  a.active && a.end_time * 1000 > Date.now() ? "" : "closed"
                }`}
                onClick={() => {
                  setLoadedAuctionId(String(a.id));
                  loadAuction(String(a.id));
                }}
              >
                <span>{a.item_name}</span>
                <span
                  className={`status ${
                    a.active && a.end_time * 1000 > Date.now()
                      ? "active"
                      : "closed"
                  }`}
                >
                  {a.active && a.end_time * 1000 > Date.now()
                    ? "Activa"
                    : "Cerrada"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* Estado de la subasta */}
      <section className="section">
        <h2>Estado de la subasta</h2>
        {auctionStatus ? (
          <div className="message">
            <div>
              <strong>Artículo:</strong> {auctionStatus.item_name}
            </div>
            <div>
              <strong>Precio actual:</strong> {auctionStatus.current_price}
            </div>
            <div>
              <strong>Ganador provisional:</strong>{" "}
              {auctionStatus.current_winner || "—"}
            </div>
            <div>
              <strong>Incremento mínimo:</strong> {auctionStatus.min_increment}
            </div>
            <div>
              <strong>Tiempo restante:</strong> {timeLeft}
            </div>
            <div>
              <strong>Activa:</strong> {auctionStatus.active ? "Sí" : "No"}
            </div>
          </div>
        ) : (
          <div className="message">No hay subasta cargada.</div>
        )}
      </section>
      {/* Puja */}     {" "}
      <section className="section">
                <h2>Realizar puja</h2>       {" "}
        <form onSubmit={handlePlaceBid}>
                   {" "}
          <input
            placeholder="Monto de la puja"
            value={bidAmount}
            onChange={(e) => setBidAmount(e.target.value)}
            type="number"
            // AÑADIDO: Lógica de deshabilitación
            disabled={
              !auctionStatus?.active || isBidding || timeLeft === "Finalizada"
            }
          />
                   {" "}
          <button
            type="submit"
            // AÑADIDO: Lógica de deshabilitación
            disabled={
              !auctionStatus?.active ||
              isBidding ||
              !bidAmount.trim() ||
              timeLeft === "Finalizada"
            }
          >
            {/* AÑADIDO: Texto dinámico */}           {" "}
            {isBidding ? "Pujando..." : "Pujar"}         {" "}
          </button>
                 {" "}
        </form>
             {" "}
      </section>
      {/* Historial de pujas */}
      <section className="section">
        <h2>Historial de pujas</h2>
        {bids.length === 0 ? (
          <div className="message">Aún no hay pujas.</div>
        ) : (
          <table className="bids-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Usuario</th>
                <th>Monto</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {bids.map((b) => (
                <tr key={b.id}>
                  <td>{b.id}</td>
                  <td>{userMap[b.user_id] || `Usuario ${b.user_id}`}</td>
                  <td>{b.amount}</td>
                  <td>{fmtTs(b.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {/* Mensajes */}
      <section className="section">
        <h2>Mensajes</h2>
        <div className="message">{message || "—"}</div>
      </section>
      <footer>© 2025 Sistema de Subastas </footer>
    </div>
  );
}
