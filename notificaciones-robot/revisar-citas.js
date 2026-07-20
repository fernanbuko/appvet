// Este script lo ejecuta GitHub Actions cada cierto tiempo (ver el archivo
// .github/workflows/revisar-citas.yml). Revisa si hay pacientes cuya
// próxima cita está por comenzar, y si es así, manda una notificación push
// al celular del doctor/a (o de todo el equipo, si el paciente pertenece a
// una clínica compartida).
//
// No modifica nada más de la app: solo LEE pacientes y config, y ESCRIBE
// una marca en el paciente para no avisar dos veces por la misma cita.

const admin = require("firebase-admin");

// La llave de servicio viene de un "secreto" de GitHub (nunca se sube al
// repositorio en texto plano). Ver las instrucciones para configurarlo.
const crudo = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
let serviceAccount;
try {
  serviceAccount = JSON.parse(crudo);
} catch (e) {
  // No se imprime el contenido del secreto (GitHub lo oculta de todas formas),
  // pero sí datos que ayudan a diagnosticar SIN revelar nada sensible.
  console.error("❌ El secreto FIREBASE_SERVICE_ACCOUNT_JSON no se pudo leer como JSON válido.");
  console.error("Longitud recibida (caracteres):", crudo.length);
  console.error("¿Empieza con '{'?:", crudo.trimStart().startsWith("{"));
  console.error("¿Termina con '}'?:", crudo.trimEnd().endsWith("}"));
  console.error("Mensaje del error de parseo:", e.message);
  process.exit(1);
}
if (!serviceAccount.private_key || !serviceAccount.client_email || !serviceAccount.project_id) {
  console.error("❌ El JSON se leyó, pero le faltan campos esperados (private_key, client_email o project_id).");
  console.error("Campos presentes:", Object.keys(serviceAccount).join(", "));
  process.exit(1);
}
console.log("✅ Llave de servicio leída correctamente para el proyecto:", serviceAccount.project_id);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// Ventana de aviso: se notifica cuando falten entre 0 y 30 minutos para la
// cita (una sola vez por cita, gracias a la marca que se guarda después).
const MINUTOS_VENTANA = 30;

function hoyComoTexto() {
  // Fecha de hoy en formato YYYY-MM-DD (igual que se guarda en la app)
  const ahora = new Date();
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, "0");
  const d = String(ahora.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function minutosHastaLaCita(fechaTexto, horaTexto) {
  // fechaTexto: "YYYY-MM-DD", horaTexto: "HH:MM"
  const [anio, mes, dia] = fechaTexto.split("-").map(Number);
  const [hora, minuto] = horaTexto.split(":").map(Number);
  const momentoCita = new Date(anio, mes - 1, dia, hora, minuto, 0);
  const ahora = new Date();
  return Math.round((momentoCita - ahora) / 60000);
}

async function tokensDeUsuario(uid) {
  try {
    const doc = await db.collection("users").doc(uid).collection("data").doc("config").get();
    if (!doc.exists) return [];
    return doc.data()?.value?.fcmTokens || [];
  } catch (e) {
    console.error(`Error leyendo config de users/${uid}:`, e.message);
    return [];
  }
}

async function tokensDeClinica(clinicaId) {
  // Todos los doctores cuyo config.clinicaId apunta a esta clínica
  // comparten los mismos pacientes, así que se avisa a todo el equipo.
  try {
    const snap = await db
      .collectionGroup("data")
      .where("value.clinicaId", "==", clinicaId)
      .get();
    const tokens = [];
    snap.forEach((doc) => {
      const lista = doc.data()?.value?.fcmTokens || [];
      tokens.push(...lista);
    });
    return [...new Set(tokens)];
  } catch (e) {
    console.error(`Error buscando equipo de clinics/${clinicaId}:`, e.message);
    return [];
  }
}

async function main() {
  const hoy = hoyComoTexto();
  console.log(`Revisando citas para el día ${hoy}...`);

  // collectionGroup: revisa TODOS los "patients" del sistema, sin importar
  // si están bajo users/{uid}/patients o clinics/{clinicaId}/patients.
  const snap = await db
    .collectionGroup("patients")
    .where("proximaVisita", "==", hoy)
    .get();

  console.log(`Pacientes con cita hoy: ${snap.size}`);

  let avisosMandados = 0;

  for (const doc of snap.docs) {
    const paciente = doc.data();

    if (!paciente.proximaVisitaHora) continue; // sin hora, no se puede calcular "está por comenzar"
    if (paciente.eliminadoEn) continue; // en la papelera, ignorar

    const yaAvisadoHoy = paciente.recordatorioEnviadoPara === hoy;
    if (yaAvisadoHoy) continue;

    const minutosRestantes = minutosHastaLaCita(paciente.proximaVisita, paciente.proximaVisitaHora);
    if (minutosRestantes < 0 || minutosRestantes > MINUTOS_VENTANA) continue;

    // ¿Este paciente vive bajo users/{uid}/patients o clinics/{clinicaId}/patients?
    const coleccionPadre = doc.ref.parent.parent; // referencia al doc "users/{uid}" o "clinics/{clinicaId}"
    const tipoPadre = doc.ref.parent.parent.parent.id; // "users" o "clinics"
    const idPadre = coleccionPadre.id;

    const tokens = tipoPadre === "clinics" ? await tokensDeClinica(idPadre) : await tokensDeUsuario(idPadre);

    if (tokens.length === 0) {
      console.log(`Paciente ${paciente.nombre}: sin dispositivos con notificaciones activadas, se omite.`);
      continue;
    }

    const mensaje = {
      notification: {
        title: `Cita en ${minutosRestantes <= 1 ? "un momento" : minutosRestantes + " min"}: ${paciente.nombre}`,
        body: paciente.propietario ? `Propietario: ${paciente.propietario}` : "Revisa la ficha del paciente.",
      },
      data: { patientId: paciente.id || doc.id },
      tokens,
    };

    try {
      const resultado = await messaging.sendEachForMulticast(mensaje);
      console.log(`Notificación enviada para ${paciente.nombre}: ${resultado.successCount} éxito(s), ${resultado.failureCount} fallo(s).`);
      avisosMandados++;
    } catch (e) {
      console.error(`Error enviando notificación para ${paciente.nombre}:`, e.message);
    }

    // Marca para no volver a avisar por esta misma cita en la próxima corrida.
    await doc.ref.update({ recordatorioEnviadoPara: hoy });
  }

  console.log(`Listo. Avisos mandados en esta corrida: ${avisosMandados}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Error general del robot de notificaciones:", e);
    process.exit(1);
  });
