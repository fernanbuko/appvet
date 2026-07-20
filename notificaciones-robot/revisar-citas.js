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
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// Ventana de aviso: se notifica cuando falten entre 0 y 30 minutos para la
// cita (una sola vez por cita, gracias a la marca que se guarda después).
const MINUTOS_VENTANA = 30;

function hoyComoTexto() {
  const ahora = new Date();
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, "0");
  const d = String(ahora.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function minutosHastaLaCita(fechaTexto, horaTexto) {
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

  const snap = await db
    .collectionGroup("patients")
    .where("proximaVisita", "==", hoy)
    .get();

  console.log(`Pacientes con cita hoy: ${snap.size}`);

  let avisosMandados = 0;

  for (const doc of snap.docs) {
    const paciente = doc.data();

    if (!paciente.proximaVisitaHora) continue;
    if (paciente.eliminadoEn) continue;

    const yaAvisadoHoy = paciente.recordatorioEnviadoPara === hoy;
    if (yaAvisadoHoy) continue;

    const minutosRestantes = minutosHastaLaCita(paciente.proximaVisita, paciente.proximaVisitaHora);
    if (minutosRestantes < 0 || minutosRestantes > MINUTOS_VENTANA) continue;

    const coleccionPadre = doc.ref.parent.parent;
    const tipoPadre = doc.ref.parent.parent.parent.id;
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
